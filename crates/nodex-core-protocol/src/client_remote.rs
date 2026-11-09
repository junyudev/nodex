//! Native CLI pin-first TLS. A remote credential file selects one Space; no local fallback.
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use sha2::{Digest, Sha256};
use std::{
    io,
    net::{TcpStream, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};

#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteConnection {
    pub url: String,
    pub fingerprint: String,
    pub space_id: String,
    pub device_credential: String,
}
#[derive(Clone, Debug)]
pub(super) struct RemoteEndpoint {
    host: String,
    port: u16,
    pin: Vec<u8>,
}
impl RemoteEndpoint {
    pub(super) fn new(connection: &RemoteConnection) -> io::Result<Self> {
        let invalid = || {
            io::Error::other(
                "Remote connection requires an HTTPS origin, Space and full certificate fingerprint",
            )
        };
        let url = url::Url::parse(&connection.url).map_err(|_| invalid())?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || connection.space_id.is_empty()
            || connection.device_credential.len() != 64
        {
            return Err(invalid());
        }
        let pin = hex::decode(&connection.fingerprint).map_err(|_| invalid())?;
        if pin.len() != 32 {
            return Err(invalid());
        }
        Ok(Self {
            host: url
                .host_str()
                .ok_or_else(invalid)?
                .trim_matches(['[', ']'])
                .to_owned(),
            port: url.port_or_known_default().ok_or_else(invalid)?,
            pin,
        })
    }
    pub(super) fn open(
        &self,
        timeout: Duration,
    ) -> io::Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>> {
        let address = (self.host.as_str(), self.port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::other("Remote host has no address"))?;
        let socket = TcpStream::connect_timeout(&address, timeout)?;
        socket.set_read_timeout(Some(timeout))?;
        socket.set_write_timeout(Some(timeout))?;
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin(self.pin.clone())))
        .with_no_client_auth();
        let name = ServerName::try_from(self.host.clone()).map_err(io::Error::other)?;
        let connection =
            rustls::ClientConnection::new(Arc::new(config), name).map_err(io::Error::other)?;
        // rustls performs the pin check during handshake, before buffering any HTTP bytes.
        let mut stream = rustls::StreamOwned::new(connection, socket);
        while stream.conn.is_handshaking() {
            stream.conn.complete_io(&mut stream.sock)?;
        }
        Ok(stream)
    }
}
#[derive(Debug)]
struct Pin(Vec<u8>);
impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if Sha256::digest(cert.as_ref()).as_slice() != self.0 {
            return Err(rustls::Error::General(
                "Space certificate pin mismatch".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
