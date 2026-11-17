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
    let field = if context { 5 } else { field };
    if quality.is_strong() {
        field * 4 + quality as usize
    } else {
        24 + field * 2 + (quality as usize - SearchTermMatchQuality::Typo as usize)
    }
}
