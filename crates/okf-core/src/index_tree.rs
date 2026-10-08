//! `index.md` parsing and synthesis for progressive-disclosure navigation.
//!
//! For every directory in the bundle we emit one [`IndexNode`]. If the directory
//! has an `index.md`, parse it into a title (`# H1`) and headed sections of
//! `* [Title](href) - description` bullets; otherwise synthesize a listing of
//! that directory's immediate children (marked `synthesized: true`). Authored
//! indexes retain their sections and entries, with unlisted child directories
//! and concepts appended so incomplete indexes cannot hide bundle documents.
//!
//! Entry resolution reuses the link rules: a concept entry's `target` is the
//! resolved Concept ID; a directory entry targets the subdirectory path. A
//! bullet points at a subdirectory either with a trailing slash (`foo/`) or by
//! linking the directory's reserved `index.md` (`foo/index.md`) — both descend
//! into `foo`, since the spec says `index.md` is never a concept. The root
//! `index.md` may carry frontmatter (`okf_version`), split off before parsing.

use crate::frontmatter;
use crate::links;
use crate::model::{Concept, EntryKind, IndexEntry, IndexNode, IndexSection};
use regex::Regex;
use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use walkdir::WalkDir;

/// Build the index-tree for a bundle, one node per directory, sorted by `dir`.
pub fn build(root: &Path, concepts: &[Concept]) -> Vec<IndexNode> {
    let ids: HashSet<String> = concepts.iter().map(|c| c.id.clone()).collect();
    let ignore = crate::ignore::IgnoreMatcher::load(root);

    // Every directory under the root (including the root itself, dir = "").
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    dirs.insert(String::new());
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !crate::parse::is_ignored_dir(e.path(), root))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_dir())
        .filter(|entry| {
            if !ignore.is_ignored(entry.path(), true) {
                return true;
            }
            let relative = rel_dir(root, entry.path());
            concepts.iter().any(|concept| {
                concept.id == relative || concept.id.starts_with(&format!("{relative}/"))
            })
        })
    {
        dirs.insert(rel_dir(root, entry.path()));
    }

    let mut nodes: Vec<IndexNode> = dirs
        .into_iter()
        .map(|dir| node_for_dir(root, &dir, &ids))
        .collect();
    // Read every index before linking children so fallback folder entries use
    // the child's authored title, including prose-only indexes.
    let directories: Vec<IndexEntry> = nodes
        .iter()
        .filter(|node| !node.dir.is_empty())
        .map(|node| IndexEntry {
            title: node.title.clone(),
            target: node.dir.clone(),
            description: String::new(),
            kind: EntryKind::Directory,
        })
        .collect();
    for node in &mut nodes {
        append_unlisted_children(node, concepts, &directories);
    }
    nodes
}

/// Build the [`IndexNode`] for one directory: parse its `index.md` or synthesize.
fn node_for_dir(root: &Path, dir: &str, ids: &HashSet<String>) -> IndexNode {
    let index_path = if dir.is_empty() {
        root.join("index.md")
    } else {
        root.join(dir).join("index.md")
    };

    if let Ok(text) = std::fs::read_to_string(&index_path) {
        parse_index(dir, &text, ids)
    } else {
        synthesize(dir)
    }
}

/// Parse an `index.md` body into a node. Frontmatter (root only) is split off.
fn parse_index(dir: &str, text: &str, ids: &HashSet<String>) -> IndexNode {
    let (_, body) = frontmatter::split(text);

    let title = first_h1(body).unwrap_or_else(|| dir_title(dir));

    let mut sections: Vec<IndexSection> = Vec::new();
    let mut current: Option<IndexSection> = None;
    // The implicit "lead" section for bullets before any `# Heading`.
    let mut had_heading = false;

    for (_, raw) in navigation_lines(body) {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim_start();

        if let Some(heading) = trimmed.strip_prefix("# ") {
            had_heading = true;
            if let Some(prev) = current.take() {
                if !prev.entries.is_empty() {
                    sections.push(prev);
                }
            }
            current = Some(IndexSection {
                heading: heading.trim().to_string(),
                entries: Vec::new(),
            });
            continue;
        }

        if let Some(entry) = parse_bullet(trimmed, dir, ids) {
            // Bullets before any heading form an unnamed lead section.
            if current.is_none() && !had_heading {
                current = Some(IndexSection {
                    heading: String::new(),
                    entries: Vec::new(),
                });
            }
            if let Some(section) = current.as_mut() {
                section.entries.push(entry);
            }
        }
    }

    if let Some(last) = current.take() {
        if !last.entries.is_empty() {
            sections.push(last);
        }
    }

    IndexNode {
        dir: dir.to_string(),
        title,
        intro: extract_intro(body, dir, ids),
        synthesized: false,
        sections,
    }
}

/// The folder-home prose for an `index.md` body: the narrative an author writes
/// around the navigation lists. Drops the leading `# H1` (shown as the title),
/// every link-bullet line (those *are* the tree/graph, so re-showing them is
/// noise), and any heading orphaned by that removal (no prose of its own left).
/// Blank runs collapse; leading/trailing blanks trim. Empty when nothing but
/// lists remains.
fn extract_intro(body: &str, dir: &str, ids: &HashSet<String>) -> String {
    // Pass 1: keep non-bullet lines, dropping only the first `# H1` (the title).
    let mut kept: Vec<&str> = Vec::new();
    let mut dropped_title = false;
    let navigation: HashSet<usize> = navigation_lines(body).map(|(i, _)| i).collect();
    for (i, raw) in body.lines().enumerate() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim_start();
        if !navigation.contains(&i) {
            kept.push(line);
            continue;
        }
        if !dropped_title && trimmed.starts_with("# ") {
            dropped_title = true;
            continue;
        }
        if parse_bullet(trimmed, dir, ids).is_some() {
            continue;
        }
        kept.push(line);
    }

    // Pass 2: drop ATX headings with no prose before the next heading or EOF.
    let mut out: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < kept.len() {
        if is_atx_heading(kept[i].trim_start()) {
            let has_prose = kept[i + 1..]
                .iter()
                .take_while(|l| !is_atx_heading(l.trim_start()))
                .any(|l| !l.trim().is_empty());
            if has_prose {
                out.push(kept[i]);
            }
        } else {
            out.push(kept[i]);
        }
        i += 1;
    }

    // Collapse blank runs and trim the ends.
    let mut result: Vec<&str> = Vec::new();
    for line in out {
        let blank = line.trim().is_empty();
        if blank
            && result
                .last()
                .map(|l: &&str| l.trim().is_empty())
                .unwrap_or(true)
        {
            continue; // no leading blanks, no double blanks
        }
        result.push(line);
    }
    while result.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        result.pop();
    }
    result.join("\n")
}

/// A markdown ATX heading line: 1–6 `#` then a space (`# `, `## `, …).
fn is_atx_heading(trimmed: &str) -> bool {
    let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
    (1..=6).contains(&hashes) && trimmed.as_bytes().get(hashes) == Some(&b' ')
}

/// Only navigation prose, not fenced examples. Keep original line numbers.
fn navigation_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut fence: Option<(char, usize)> = None;
    text.lines().enumerate().filter(move |(_, line)| {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().unwrap_or(' ');
        let length = trimmed.chars().take_while(|c| *c == marker).count();
        if matches!(marker, '`' | '~') && length >= 3 {
            match fence {
                None => fence = Some((marker, length)),
                Some((open, width))
                    if marker == open && length >= width && trimmed[length..].trim().is_empty() =>
                {
                    fence = None;
                }
                _ => {}
            }
            return false;
        }
        fence.is_none()
    })
}

/// Tolerate colon-separated descriptions when reading, but report them below.
fn bullet_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[*\-]\s+\[([^\]]*)\]\(([^)\s]+)\)(?:\s*(?P<separator>[-–—:])\s*(?P<description>.*))?$").unwrap()
    })
}

/// Diagnose navigation-shaped bullets without rejecting readable knowledge or
/// modifying source files. This is a consumer compatibility check, not repair.
pub(crate) fn navigation_warnings(text: &str) -> Vec<(usize, String)> {
    let (_, body) = frontmatter::split(text);
    let offset = text[..text.len() - body.len()].lines().count();
    static CANDIDATE: OnceLock<Regex> = OnceLock::new();
    let candidate = CANDIDATE.get_or_init(|| Regex::new(r"^[*+\-]\s+\[[^\]]*\]\s*[\[(]").unwrap());
    navigation_lines(body)
        .filter_map(|(i, raw)| {
            let line = raw.trim();
            if !candidate.is_match(line) {
                return None;
            }
            let message = match bullet_re().captures(line) {
                Some(caps) if caps.name("separator").map(|m| m.as_str()) == Some(":") =>
                    "non-standard index separator ':'; use '[Title](path) - description'. The entry remains navigable.",
                Some(_) => return None,
                None => "unrecognized index navigation entry; use '* [Title](path) - description'. The original prose is retained.",
            };
            Some((offset + i + 1, message.to_string()))
        })
        .collect()
}

/// Parse one bullet line into an [`IndexEntry`], or `None` if it is not a
/// link bullet. `dir` anchors relative hrefs for concept resolution.
fn parse_bullet(line: &str, dir: &str, ids: &HashSet<String>) -> Option<IndexEntry> {
    let caps = bullet_re().captures(line)?;
    let title = caps
        .get(1)
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default();
    let href = caps.get(2)?.as_str();
    let description = caps
        .name("description")
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default();

    // Skip external links — index entries point inside the bundle.
    if links::is_external(href) {
        return None;
    }

    if let Some(subdir) = href.strip_suffix('/') {
        // Directory entry: target is the subdirectory path relative to root.
        let target = join_dir(dir, subdir);
        Some(IndexEntry {
            title,
            target,
            description,
            kind: EntryKind::Directory,
        })
    } else {
        // Resolve the href to a bundle path. Use a synthetic source id in this
        // directory so relative `./`, `../`, and bundle-absolute hrefs anchor here.
        let anchor = if dir.is_empty() {
            "index".to_string()
        } else {
            format!("{dir}/index")
        };
        let without_anchor = href.split('#').next().unwrap_or(href);
        let target =
            links::resolve(without_anchor, &anchor).unwrap_or_else(|| without_anchor.to_string());

        // A link to a directory's reserved `index.md` is a directory entry — the
        // explicit-path twin of the `foo/` form above, so `[Ref](reference/index.md)`
        // descends into `reference/` just like `[Ref](reference/)`. Per the spec,
        // `index.md` is never a concept, so this can never be a real concept target.
        if let Some(subdir) = index_target_dir(&target) {
            Some(IndexEntry {
                title,
                target: subdir,
                description,
                kind: EntryKind::Directory,
            })
        } else {
            // Concept entry. Keep it even if the target does not resolve to a
            // known concept; navigation renders it and validation reports broken
            // links separately.
            let _ = ids; // resolution does not require existence for index display
            Some(IndexEntry {
                title,
                target,
                description,
                kind: EntryKind::Concept,
            })
        }
    }
}

/// If `target` is a directory's reserved index (`index` or `…/index`, the result
/// of resolving a `…/index.md` href), return the directory it descends into
/// (`""` for the bundle root). Otherwise `None` — it is a concept target.
fn index_target_dir(target: &str) -> Option<String> {
    if target == "index" {
        Some(String::new())
    } else {
        target.strip_suffix("/index").map(str::to_string)
    }
}

/// Complete the navigation model without changing any authored entry or file.
/// Only immediate children are added: each folder remains an expandable level.
fn append_unlisted_children(
    node: &mut IndexNode,
    concepts: &[Concept],
    directories: &[IndexEntry],
) {
    let listed_concepts: HashSet<&str> = node
        .sections
        .iter()
        .flat_map(|section| &section.entries)
        .filter(|entry| entry.kind == EntryKind::Concept)
        .map(|entry| entry.target.as_str())
        .collect();
    let listed_directories: HashSet<&str> = node
        .sections
        .iter()
        .flat_map(|section| &section.entries)
        .filter(|entry| entry.kind == EntryKind::Directory)
        .map(|entry| entry.target.as_str())
        .collect();
    let mut entries: Vec<IndexEntry> = directories
        .iter()
        .filter(|entry| {
            is_immediate_child(&node.dir, &entry.target)
                && !listed_directories.contains(entry.target.as_str())
        })
        .cloned()
        .chain(
            concepts
                .iter()
                .filter(|concept| {
                    is_immediate_child(&node.dir, &concept.id)
                        && !listed_concepts.contains(concept.id.as_str())
                })
                .map(|concept| IndexEntry {
                    title: concept.title.clone(),
                    target: concept.id.clone(),
                    description: concept.description.clone(),
                    kind: EntryKind::Concept,
                }),
        )
        .collect();
    entries.sort_by(|a, b| {
        // Folders first, then display title and path for deterministic ties.
        (a.kind == EntryKind::Concept)
            .cmp(&(b.kind == EntryKind::Concept))
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.target.cmp(&b.target))
    });
    if !entries.is_empty() {
        node.sections.push(IndexSection {
            heading: String::new(),
            entries,
        });
    }
}

/// Start a synthesized node; the shared completion pass adds its children.
fn synthesize(dir: &str) -> IndexNode {
    IndexNode {
        dir: dir.to_string(),
        title: dir_title(dir),
        intro: String::new(),
        synthesized: true,
        sections: Vec::new(),
    }
}

/// True if a concept or directory `id` lives directly in `dir`.
fn is_immediate_child(dir: &str, id: &str) -> bool {
    match id.rsplit_once('/') {
        Some((parent, _)) => parent == dir,
        None => dir.is_empty(),
    }
}

/// Directory path relative to root, forward-slashed; "" for the root itself.
fn rel_dir(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}

/// Join a base directory with a sub-path, dropping empty segments.
fn join_dir(dir: &str, sub: &str) -> String {
    let sub = sub.trim_matches('/');
    if dir.is_empty() {
        sub.to_string()
    } else if sub.is_empty() {
        dir.to_string()
    } else {
        format!("{dir}/{sub}")
    }
}

/// A human title for a directory ("" → "Bundle Root").
fn dir_title(dir: &str) -> String {
    if dir.is_empty() {
        "Bundle Root".to_string()
    } else {
        dir.rsplit('/').next().unwrap_or(dir).to_string()
    }
}

/// First `# H1` heading in `text`.
fn first_h1(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_sections_and_entries() {
        let text = "# Architecture\n\nIntro prose.\n\n* [Tech Stack](tech-stack.md) - Tauri and why.\n* [Data Model](data-model.md)\n";
        let node = parse_index("architecture", text, &ids(&[]));
        assert_eq!(node.title, "Architecture");
        assert!(!node.synthesized);
        // One lead section with two entries.
        let all: Vec<_> = node.sections.iter().flat_map(|s| &s.entries).collect();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "Tech Stack");
        assert_eq!(all[0].target, "architecture/tech-stack");
        assert_eq!(all[0].description, "Tauri and why.");
        assert_eq!(all[1].description, ""); // missing description tolerated
                                            // The lead prose is retained; the title H1 and the link-bullets are not.
        assert_eq!(node.intro, "Intro prose.");
    }

    #[test]
    fn intro_drops_title_bullets_and_orphaned_headings() {
        // A root-index shape: title, lead prose, then heading-only sections whose
        // bullets are the tree. The intro keeps only the narrative.
        let text = "# Bundle\n\nWhat this is.\nSecond line.\n\n# Product\n\n* [Overview](product/overview.md) - the pitch.\n\n# Subdirectories\n\n* [Product](product/) - vision.\n";
        let node = parse_index("", text, &ids(&[]));
        assert_eq!(node.intro, "What this is.\nSecond line.");
    }

    #[test]
    fn intro_keeps_prose_under_a_heading() {
        // A heading that still has prose after its bullets are stripped survives.
        let text = "# Top\n\nLead.\n\n# Notes\n\nWhy these live together.\n\n* [A](a.md)\n";
        let node = parse_index("d", text, &ids(&[]));
        assert_eq!(node.intro, "Lead.\n\n# Notes\n\nWhy these live together.");
    }

    #[test]
    fn intro_empty_for_bare_list() {
        let text = "# Top\n\n* [A](a.md)\n* [B](b.md)\n";
        let node = parse_index("d", text, &ids(&[]));
        assert_eq!(node.intro, "");
    }

    #[test]
    fn synthesized_node_has_no_intro() {
        let node = synthesize("features");
        assert!(node.synthesized);
        assert_eq!(node.intro, "");
    }

    #[test]
    fn directory_entry_detected() {
        let text = "# Top\n* [Features](features/) - the features.\n";
        let node = parse_index("", text, &ids(&[]));
        let e = &node.sections[0].entries[0];
        assert_eq!(e.kind, EntryKind::Directory);
        assert_eq!(e.target, "features");
    }

    #[test]
    fn index_md_link_is_a_directory_entry() {
        // `[Reference](reference/index.md)` from the root descends into
        // `reference/`, exactly like the trailing-slash `reference/` form.
        let text = "# Top\n* [Reference](reference/index.md) - the API.\n";
        let node = parse_index("", text, &ids(&[]));
        let e = &node.sections[0].entries[0];
        assert_eq!(e.kind, EntryKind::Directory);
        assert_eq!(e.target, "reference");
        assert_eq!(e.description, "the API.");
    }

    #[test]
    fn nested_index_md_link_resolves_relative() {
        // From the `reference` index, `[react](react/index.md)` -> `reference/react`.
        let text = "* [react](react/index.md) - core package.\n";
        let node = parse_index("reference", text, &ids(&[]));
        let e = &node.sections[0].entries[0];
        assert_eq!(e.kind, EntryKind::Directory);
        assert_eq!(e.target, "reference/react");
    }

    #[test]
    fn concept_named_with_index_suffix_stays_a_concept() {
        // Only the `/index` boundary marks a directory; `something-index` does not.
        let text = "* [Notes](something-index.md)\n";
        let node = parse_index("", text, &ids(&[]));
        let e = &node.sections[0].entries[0];
        assert_eq!(e.kind, EntryKind::Concept);
        assert_eq!(e.target, "something-index");
    }

    #[test]
    fn dash_bullets_and_anchor() {
        let text = "- [X](/a/b.md#sec) - note\n";
        let node = parse_index("z", text, &ids(&[]));
        let e = &node.sections[0].entries[0];
        assert_eq!(e.target, "a/b");
        assert_eq!(e.description, "note");
    }
}
