// Bake-off, Rust side: duckling (dates, quantities, money), llm_json (JSON repair), pluralizer (singular forms).
// Run: cargo run --release | tee ../results-rust.txt
// Written from the crates' docs without compiling (no network in the authoring sandbox): if cargo reports a type or
// signature error, paste it back and it is a one-line fix.
use chrono::{FixedOffset, TimeZone};
use duckling::{parse, Context, DimensionKind, Lang, Locale, Options};
use std::time::Instant;

fn main() {
    let cases: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("../cases.json").expect("run from bakeoff/rust")).unwrap();

    println!("======== PLURALS (X = wrong)");
    let mut ok = 0;
    let plural = cases["plural"].as_array().unwrap();
    for pair in plural {
        let (w, exp) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        let out = pluralizer::pluralize(w, 1, false);
        let good = out == exp;
        if good { ok += 1; }
        println!("{:<12} {:<11} {}{}", w, exp, out, if good { "" } else { " X" });
    }
    println!("score: {}/{}", ok, plural.len());

    println!("\n======== DUCKLING: dates, quantities, money, numerals (judge by eye)");
    let locale = Locale::new(Lang::EN, None);
    let context = Context::new(FixedOffset::east_opt(0).unwrap().with_ymd_and_hms(2026, 10, 25, 12, 0, 0).unwrap(), locale.clone());
    let options = Options::default();
    let dims = [
        DimensionKind::Time, DimensionKind::Duration, DimensionKind::Distance, DimensionKind::Quantity,
        DimensionKind::AmountOfMoney, DimensionKind::Numeral, DimensionKind::Ordinal, DimensionKind::Temperature, DimensionKind::Volume,
    ];
    let t0 = Instant::now();
    let texts = cases["text"].as_array().unwrap();
    for t in texts {
        let text = t.as_str().unwrap();
        println!("\n> {}", text);
        for e in parse(text, &locale, &dims, &context, &options) {
            println!("  [{}..{}] {:?} -> {:?}", e.start, e.end, e.body, e.value);
        }
    }
    println!("\nduckling: {} sentences in {:?}", texts.len(), t0.elapsed());

    println!("\n======== JSON REPAIR (llm_json)");
    for pair in cases["json"].as_array().unwrap() {
        let (s, what) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        match llm_json::repair_json(s, &Default::default()) {
            Ok(r) => println!("- {} -> {}", what, r.chars().take(150).collect::<String>()),
            Err(e) => println!("- {} -> ERROR {:?}", what, e),
        }
    }
}
