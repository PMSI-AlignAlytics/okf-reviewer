//! Documentation refreshes preserve historical pseudonymous human reviews.

use okf_core::frontmatter;

#[test]
fn refreshed_sample_documents_preserve_historical_human_review_events() {
    let documents = [
        (
            include_str!("../../../docs/features/quizzes.md"),
            "2026-07-30T16:59:45.983395Z",
        ),
        (
            include_str!("../../../docs/architecture/quiz-generation.md"),
            "2026-07-30T16:59:45.9953518Z",
        ),
    ];
    for (source, first_review_at) in documents {
        let (metadata, _) = frontmatter::split(source);
        let metadata = frontmatter::parse(metadata.unwrap());
        assert_eq!(metadata.scalar("status"), Some("stable"));
        let generated = metadata.value("generated").unwrap();
        let authored_at = generated["at"].as_str().unwrap();
        let reviews = metadata.entries("verified");
        assert_eq!(reviews.len(), 3);
        let times = [
            first_review_at,
            "2026-07-30T18:55:54.6076707Z",
            "2026-07-30T18:57:16.3917790Z",
        ];
        for (review, at) in reviews.iter().zip(times) {
            let attribution = frontmatter::ParsedFrontmatter::attribution(review).unwrap();
            assert_eq!(attribution.by, "human:reviewer");
            assert!(attribution.is_human());
            assert_eq!(attribution.at.as_deref(), Some(at));
            assert!(attribution.content_sha256.is_none());
            // These legacy reviews predate the refreshed wording. They remain
            // history, without claiming a human approved the new revision.
            assert!(authored_at > at);
        }
    }
}
