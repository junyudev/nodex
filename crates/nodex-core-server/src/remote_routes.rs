//! Core listener reachability and peer admission. Form factor is irrelevant here.
use nodex_core_contracts::team::ListenerPeerPolicy;
use std::net::{IpAddr, SocketAddr};

pub(crate) fn private_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|ip| private_peer(ip.into()))
            .unwrap_or_else(|| {
                ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
            }),
    }
}
pub(crate) fn routes(bound: SocketAddr, policy: ListenerPeerPolicy) -> Vec<String> {
    // A host's link-local interface scope is not portable to another Device.
    if matches!(bound.ip(), IpAddr::V6(ip) if ip.is_unicast_link_local()) {
        return vec![];
    }
    if !bound.ip().is_unspecified() {
        return if bound.ip().is_loopback() && !cfg!(debug_assertions) {
            vec![]
        } else {
            vec![format!("https://{bound}")]
        };
    }
    let mut addresses: Vec<_> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| {
            ![
                "docker",
                "vboxnet",
                "vmnet",
                "veth",
                "bridge",
                "br-",
                "awdl",
                "llw",
                "virbr",
                "podman",
                "cni",
                "flannel",
                "tap",
                "vEthernet",
            ]
            .iter()
            .any(|prefix| i.name.starts_with(prefix))
        })
        .map(|i| i.ip())
        .filter(|ip| {
            ip.is_ipv4() == bound.is_ipv4()
                && !ip.is_loopback()
                && (policy == ListenerPeerPolicy::Operator || private_peer(*ip))
        })
        // Link-local IPv6 requires the client's interface scope and cannot be a portable offer route.
        .filter(|ip| !matches!(ip,IpAddr::V6(ip) if ip.is_unicast_link_local()))
        .map(|ip| format!("https://{}", SocketAddr::new(ip, bound.port())))
        .collect();
    if cfg!(debug_assertions) {
        addresses.push(format!(
            "https://{}",
            SocketAddr::new(
                if bound.is_ipv4() {
                    "127.0.0.1".parse().unwrap()
                } else {
                    "::1".parse().unwrap()
                },
                bound.port()
            )
        ));
    }
    addresses.sort();
    addresses.dedup();
    addresses
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concrete_routes_preserve_portable_addresses_without_host_interface_scopes() {
        for address in ["169.254.2.3:8443", "100.64.1.2:8443", "[fc00::1]:8443"] {
            assert_eq!(
                routes(address.parse().unwrap(), ListenerPeerPolicy::Private),
                vec![format!("https://{address}")]
            );
        }
        assert!(
            routes(
                "[fe80::1%2]:8443".parse().unwrap(),
                ListenerPeerPolicy::Private
            )
            .is_empty()
        );
    }
    #[test]
    fn private_peer_policy_includes_tailnet_and_link_local() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.2",
            "100.64.0.1",
            "100.127.255.255",
            "169.254.2.3",
            "::1",
            "::ffff:100.64.1.2",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(private_peer(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "100.63.255.255",
            "100.128.0.1",
            "8.8.8.8",
            "0.0.0.0",
            "224.0.0.1",
            "2001:4860:4860::8888",
            "::",
        ] {
            assert!(!private_peer(ip.parse().unwrap()), "{ip}");
        }
    }
}
