//! Exercise the backported C out-argument fix with optimized GLib code.
#![cfg(target_os = "linux")]

use gtk::glib::variant::ToVariant;

#[test]
fn variant_string_iterators_keep_valid_borrowed_strings() {
    let variant = ["alpha", "beta", "gamma", "delta"].to_variant();
    let iter = || variant.array_iter_str().unwrap();
    assert_eq!(
        iter().collect::<Vec<_>>(),
        ["alpha", "beta", "gamma", "delta"]
    );
    assert_eq!(iter().last(), Some("delta"));
    assert_eq!(iter().nth(2), Some("gamma"));
    assert_eq!(iter().next_back(), Some("delta"));
    assert_eq!(iter().nth_back(2), Some("beta"));
    let mut mixed = iter();
    assert_eq!(mixed.next(), Some("alpha"));
    assert_eq!(mixed.next_back(), Some("delta"));
    assert_eq!(mixed.collect::<Vec<_>>(), ["beta", "gamma"]);
    assert_eq!(
        Vec::<String>::new()
            .to_variant()
            .array_iter_str()
            .unwrap()
            .next(),
        None
    );
}
