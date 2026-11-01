use nodex_platform::private_fs::OpenOptions;
use std::fs::{self, File};

use std::path::{Path, PathBuf};

use fs2::FileExt;

use super::sqlite::{StoreError, StoreErrorCode};

const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Debug)]
pub struct ProfileStoreLock {
    _file: File,
    path: PathBuf,
}

impl ProfileStoreLock {
    pub fn acquire(profile_home: &Path) -> Result<Self, StoreError> {
        if !profile_home.is_absolute() || !profile_home.is_dir() {
            return Err(StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Profile home must be an existing absolute directory",
                false,
            ));
        }
        let metadata = fs::symlink_metadata(profile_home).map_err(|error| {
            StoreError::new(
                StoreErrorCode::InvalidProfile,
                format!("Profile home metadata is unavailable: {error}"),
                false,
            )
        })?;
        if nodex_platform::private_fs::is_reparse_point(&metadata) {
            return Err(StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Profile home must not be a symlink",
                false,
            ));
        }

        nodex_platform::private_fs::prepare_profile_root(profile_home).map_err(io_error)?;
        let directory = profile_home.join("run/core");
        nodex_platform::private_fs::create_dir_all(&directory).map_err(io_error)?;
        if nodex_platform::private_fs::is_reparse_point(
            &fs::symlink_metadata(&directory).map_err(io_error)?,
        ) {
            return Err(StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Profile runtime directory must not be a symlink",
                false,
            ));
        }
        nodex_platform::private_fs::set_mode(&directory, PRIVATE_DIRECTORY_MODE)
            .map_err(io_error)?;
        let path = directory.join("store.lock");
        if fs::symlink_metadata(&path)
            .is_ok_and(|metadata| nodex_platform::private_fs::is_reparse_point(&metadata))
        {
            return Err(StoreError::new(
                StoreErrorCode::InvalidProfile,
                "Profile store lock must not be a symlink",
                false,
            ));
        }
        let mut options = OpenOptions::new();
        options
            .create(true)
            .read(true)
            .write(true)
            .mode(PRIVATE_FILE_MODE);
        let file = options.open(&path).map_err(io_error)?;
        nodex_platform::private_fs::set_mode(&path, PRIVATE_FILE_MODE).map_err(io_error)?;
        file.try_lock_exclusive().map_err(|_| {
            StoreError::new(
                StoreErrorCode::AlreadyOwned,
                "Another Core already owns this Profile store",
                true,
            )
        })?;
        Ok(Self { _file: file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::InvalidProfile,
        format!("Profile store lock failed: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests {

    use nodex_platform::test_support::tempdir;

    use super::*;

    #[test]
    fn one_private_lock_fences_store_open() {
        let directory = tempdir().expect("profile");
        let home = directory.path().canonicalize().expect("absolute profile");
        let first = ProfileStoreLock::acquire(&home).expect("first owner");
        assert_eq!(
            nodex_platform::private_fs::effective_mode(first.path()).expect("filesystem access"),
            PRIVATE_FILE_MODE
        );
        let second = ProfileStoreLock::acquire(&home).expect_err("second owner rejected");
        assert_eq!(second.code, StoreErrorCode::AlreadyOwned);
        drop(first);
        ProfileStoreLock::acquire(&home).expect("lock released");
    }
}
