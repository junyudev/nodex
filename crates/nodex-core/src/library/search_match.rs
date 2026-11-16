use unicode_normalization::UnicodeNormalization;

pub(super) use nodex_search_kernel::MatchQuality as SearchTermMatchQuality;

// Page keys continue to use their canonical spelling.
pub(super) fn normalize_search_text(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Context comes after body text in each tier while all strong classes
/// still outrank typo and infix evidence.
pub(super) fn rank_with_context(
    quality: SearchTermMatchQuality,
    field: usize,
    context: bool,
) -> usize {
    let rank = quality.rank(field);
    match (quality.is_strong(), context) {
        (true, true) => rank + 4,
        (true, false) => rank,
        (false, context) => (rank + 4) * 2 + usize::from(context),
    }
}
