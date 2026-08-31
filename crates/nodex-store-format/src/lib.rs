#![forbid(unsafe_code)]

pub const STORE_LINEAGE: &str = "nodex-rust-core";
pub const MIN_SUPPORTED_STORE_REVISION: u32 = 130;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PublishedStoreFormat {
    pub revision: u32,
    pub schema_fingerprint: &'static str,
}

pub const PUBLISHED_STORE_FORMATS: &[PublishedStoreFormat] = &[
    format(
        130,
        "baedc982cdfd3e48a69c8786eb5da261dd3e34a8320abedf15121f8ded935f93",
    ),
    format(
        131,
        "46dd2a5762d431f063ced596735d7330a12b1bda9854b08eea66ff9a0f81bc8c",
    ),
    format(
        132,
        "4d8a73cef28f743faea9c5718ca7eaae90c4f6473895a3fd872a7cb75e870e90",
    ),
    format(
        133,
        "7d89150ec4cc75dc5c9b91ae1eb79457e08cd2045a04f4f4e06d8b4be4e78373",
    ),
    format(
        134,
        "39abd706154ce7d3b3657353d4191a66a70e9c24f0ef35497652ad76ccf6551b",
    ),
    format(
        135,
        "374fff28f7500b603a1d7e438fcd622bc137abe7e4f1d709435faf9071966871",
    ),
    format(
        136,
        "7e117aae852b395046e30553b45ba4eb4f5a7aae4ce391ff7bdedf4642ea7f0a",
    ),
    format(
        137,
        "98a3c690e500c78f3170a334f117c5827b2b48969493dd1eacff4a2097d5241b",
    ),
    format(
        138,
        "cdd3df91f4da213e2237e00838940505c5d75fc25b2862455c48382af9c2163f",
    ),
    format(
        139,
        "fd6c6bd515a087f689038c842386f9459bbdea9334c2f7a040cb68e00ce64a6c",
    ),
    format(
        140,
        "e7b26211391a8f813e81af13446b7119fa18ff087a49f9219c2a12c2410b5bed",
    ),
    format(
        141,
        "d61a14be83835edbf6aa4d6038193e89ca8d21ad9ca0c8a404e3c7fbc25a5572",
    ),
    format(
        142,
        "9c2f2ace714e9bc97acaa87673f13f9bf1daad9b4bdbe4c28a03904287e25b4d",
    ),
    format(
        143,
        "f3c49d4629723ef7067bc00e80978791b3d5a029353a14533f793dec6afb95b9",
    ),
    format(
        144,
        "6d363ca34b09096a05d4bd3faee5887223ec1504c5bea842906c7cd4a829e094",
    ),
    format(
        145,
        "fa5b96e8df072825c7e73f8c24a0e2aa4f9ca2efa6c2a3554346926eeb08f93d",
    ),
    format(
        146,
        "10ba94cd690a9e94f773104626c4f680af40343067c467ca7c9115e686efd64b",
    ),
    format(
        147,
        "10ba94cd690a9e94f773104626c4f680af40343067c467ca7c9115e686efd64b",
    ),
    format(
        148,
        "ef41917e003824e075ffbe7bde8852283a97612cc068d5c4a3308d9b360fc5bb",
    ),
    format(
        149,
        "d2996cf3f1de13d1f1c9ba771daf3565f02be26bdb1a5fd892e352eb29f4b3b8",
    ),
    format(
        150,
        "a4199f5d978d0f647b320049ca15716cdcc843e2f78eb57ac9942346ef87a8f1",
    ),
];

pub const CURRENT_STORE_FORMAT: PublishedStoreFormat =
    PUBLISHED_STORE_FORMATS[PUBLISHED_STORE_FORMATS.len() - 1];
pub const CURRENT_STORE_VERSION: u32 = CURRENT_STORE_FORMAT.revision;
pub const CURRENT_STORE_SCHEMA_FINGERPRINT: &str = CURRENT_STORE_FORMAT.schema_fingerprint;

const fn format(revision: u32, schema_fingerprint: &'static str) -> PublishedStoreFormat {
    PublishedStoreFormat {
        revision,
        schema_fingerprint,
    }
}

pub fn published_store_format(revision: u32) -> Option<PublishedStoreFormat> {
    PUBLISHED_STORE_FORMATS
        .binary_search_by_key(&revision, |format| format.revision)
        .ok()
        .map(|index| PUBLISHED_STORE_FORMATS[index])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_contiguous_and_current_is_last() {
        let revisions = PUBLISHED_STORE_FORMATS
            .iter()
            .map(|format| format.revision)
            .collect::<Vec<_>>();
        assert_eq!(
            revisions,
            (MIN_SUPPORTED_STORE_REVISION..=CURRENT_STORE_FORMAT.revision).collect::<Vec<_>>()
        );
        assert_eq!(
            published_store_format(CURRENT_STORE_FORMAT.revision),
            Some(CURRENT_STORE_FORMAT)
        );
    }
}
