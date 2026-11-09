//! Profile listener intent belongs to Core, independently of Space membership and live sockets.
use nodex_core_contracts::team::{ListenerPeerPolicy, RemoteAccessIntent};
use nodex_platform::private_fs::{self, EntryKind};
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 4096;
const FILE: &str = "remote-access.json";

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub enabled: bool,
    pub address: String,
    pub peer_policy: ListenerPeerPolicy,
    pub cert: Option<String>,
    pub key: Option<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            address: RemoteAccessIntent::default().address,
            peer_policy: ListenerPeerPolicy::Private,
            cert: None,
            key: None,
        }
    }
}
impl Config {
    /// Certificate and private-key locations never cross the public administration boundary.
    pub(crate) fn intent(&self) -> RemoteAccessIntent {
        RemoteAccessIntent {
            enabled: self.enabled,
            address: self.address.clone(),
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn directory(home: &Path) -> PathBuf {
    home.join("team-transport")
}
fn validate(intent: &Config) -> io::Result<()> {
    if intent.peer_policy != ListenerPeerPolicy::Private {
        return Err(invalid(
            "Profile remote access requires private-peer admission",
        ));
    }
    if intent.address.len() > 128 {
        return Err(invalid("Remote access address exceeds its bound"));
    }
    let address: SocketAddr = intent
        .address
        .parse()
        .map_err(|_| invalid("Remote access requires a native socket address"))?;
    if intent.enabled && address.port() == 0 {
        return Err(invalid("Enabled remote access requires its selected port"));
    }
    match (&intent.cert, &intent.key) {
        (None, None) => {}
        (Some(cert), Some(key))
            if Path::new(cert).is_absolute()
                && Path::new(key).is_absolute()
                && cert.len() <= 1536
                && key.len() <= 1536 => {}
        _ => {
            return Err(invalid(
                "Remote access requires absolute certificate and key paths together",
            ));
        }
    }
    Ok(())
}

/// Missing intent is disabled. Unsafe, malformed or oversized state never enables a listener.
pub(crate) fn read(home: &Path) -> io::Result<Config> {
    let directory = directory(home);
    match private_fs::checked_metadata(&directory, EntryKind::Directory, Some(0o700)) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Config::default());
        }
        Err(error) => return Err(error),
    }
    let path = directory.join(FILE);
    match private_fs::checked_metadata(&path, EntryKind::File, Some(0o600)) {
        Ok(metadata) if metadata.len() > MAX_BYTES => {
            return Err(invalid("Remote access configuration exceeds its bound"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Config::default());
        }
        Err(error) => return Err(error),
    }
    let file = private_fs::open_regular(&path, false)?;
    private_fs::validate_private_handle(&file, 0o600)?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("Remote access configuration exceeds its bound"));
    }
    let intent = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Remote access configuration is invalid"))?;
    validate(&intent)?;
    Ok(intent)
}

/// Publish one complete private intent. The caller serializes this with listener administration.
pub(crate) fn write(home: &Path, intent: &Config) -> io::Result<()> {
    validate(intent)?;
    // Do not overwrite uncertain state, including aliases and an unsafe existing directory.
    read(home)?;
    let directory = directory(home);
    private_fs::create_dir_all(&directory)?;
    private_fs::checked_metadata(&directory, EntryKind::Directory, Some(0o700))?;
    let bytes = serde_json::to_vec(intent)
        .map_err(|_| invalid("Remote access configuration cannot be encoded"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("Remote access configuration exceeds its bound"));
    }
    let nonce = super::host_bridge::credential()
        .map_err(|_| io::Error::other("Remote access staging identity is unavailable"))?;
    let pending = directory.join(format!("remote-access-{nonce}.pending"));
    let result = (|| {
        let mut file = private_fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&pending)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        private_fs::atomic_replace(&pending, directory.join(FILE))?;
        private_fs::sync_directory(&directory)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(pending);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_platform::test_support::tempdir;

    #[test]
    fn intent_is_private_bounded_and_round_trips_without_a_listener() {
        let home = tempdir().unwrap();
        assert_eq!(read(home.path()).unwrap(), Config::default());
        let intent = Config {
            enabled: true,
            address: "0.0.0.0:18443".into(),
            peer_policy: ListenerPeerPolicy::Private,
            cert: None,
            key: None,
        };
        write(home.path(), &intent).unwrap();
        assert_eq!(read(home.path()).unwrap(), intent);
        private_fs::checked_metadata(
            &directory(home.path()).join(FILE),
            EntryKind::File,
            Some(0o600),
        )
        .unwrap();
        let disabled = Config {
            enabled: false,
            ..intent
        };
        write(home.path(), &disabled).unwrap();
        assert_eq!(read(home.path()).unwrap(), disabled);
        assert_eq!(
            std::fs::read_dir(directory(home.path())).unwrap().count(),
            1
        );
    }

    #[test]
    fn certificate_paths_stay_private_and_survive_disabled_intent() {
        let home = tempdir().unwrap();
        let config = Config {
            enabled: false,
            address: "127.0.0.1:8443".into(),
            peer_policy: ListenerPeerPolicy::Private,
            cert: Some(
                home.path()
                    .join("server.pem")
                    .to_string_lossy()
                    .into_owned(),
            ),
            key: Some(home.path().join("key.pem").to_string_lossy().into_owned()),
        };
        write(home.path(), &config).unwrap();
        let saved = read(home.path()).unwrap();
        assert_eq!(saved, config);
        assert_eq!(
            serde_json::to_value(saved.intent()).unwrap(),
            serde_json::json!({"enabled":false,"address":"127.0.0.1:8443"})
        );
        assert!(
            write(
                home.path(),
                &Config {
                    key: None,
                    ..config.clone()
                }
            )
            .is_err()
        );
        assert!(
            write(
                home.path(),
                &Config {
                    cert: Some("relative.pem".into()),
                    ..config
                }
            )
            .is_err()
        );
    }

    #[test]
    fn invalid_and_oversized_intent_cannot_replace_valid_state() {
        let home = tempdir().unwrap();
        let valid = Config {
            enabled: true,
            address: "127.0.0.1:8443".into(),
            peer_policy: ListenerPeerPolicy::Private,
            cert: None,
            key: None,
        };
        write(home.path(), &valid).unwrap();
        for address in ["127.0.0.1:0", "https://host.local", "../socket", ""] {
            assert!(
                write(
                    home.path(),
                    &Config {
                        enabled: true,
                        address: address.into(),
                        peer_policy: ListenerPeerPolicy::Private,
                        cert: None,
                        key: None
                    }
                )
                .is_err()
            );
        }
        assert_eq!(read(home.path()).unwrap(), valid);
        private_fs::write(
            directory(home.path()).join(FILE),
            vec![b' '; MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert!(read(home.path()).is_err());
    }

    #[test]
    fn malformed_or_aliased_intent_is_never_adopted_or_overwritten() {
        let home = tempdir().unwrap();
        private_fs::create_dir_all(directory(home.path())).unwrap();
        let path = directory(home.path()).join(FILE);
        private_fs::write(
            &path,
            br#"{"enabled":true,"address":"127.0.0.1:8443","peer_policy":"private","unknown":true}"#,
        )
        .unwrap();
        assert!(read(home.path()).is_err());
        assert!(write(home.path(), &Config::default()).is_err());
        std::fs::remove_file(&path).unwrap();
        let target = home.path().join("external");
        private_fs::write(&target, b"unchanged").unwrap();
        private_fs::symlink(&target, &path).unwrap();
        assert!(read(home.path()).is_err());
        assert!(write(home.path(), &Config::default()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"unchanged");
    }

    #[test]
    fn operator_policy_cannot_become_profile_restore_intent() {
        let home = tempdir().unwrap();
        write(home.path(), &Config::default()).unwrap();
        assert!(
            write(
                home.path(),
                &Config {
                    peer_policy: ListenerPeerPolicy::Operator,
                    ..Config::default()
                }
            )
            .is_err()
        );
        let path = directory(home.path()).join(FILE);
        private_fs::write(&path, br#"{"enabled":true,"address":"127.0.0.1:8443","peer_policy":"operator","cert":null,"key":null}"#).unwrap();
        assert!(read(home.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_permissions_fail_closed() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempdir().unwrap();
        write(home.path(), &Config::default()).unwrap();
        let path = directory(home.path()).join(FILE);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read(home.path()).is_err());
        assert!(write(home.path(), &Config::default()).is_err());
    }
}
