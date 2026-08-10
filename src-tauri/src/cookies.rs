//! A cookie jar for reqwest.
//!
//! `cookie_store` implements the hard part — domain and path matching, expiry,
//! `Secure`/`HttpOnly`, public-suffix rules — and reqwest defines a two-method
//! trait for plugging a jar in. This module is the ~40 lines that join them.
//!
//! There is a crate that does exactly this (`reqwest_cookie_store`), and it was
//! tried first. It pins a reqwest major version, so with reqwest 0.12 here and
//! 0.13 there Cargo linked **two copies of reqwest** and the trait impl was for
//! the wrong one. Owning these lines removes a version lockstep on a dependency
//! whose whole content is below, and keeps the cookie semantics — the part
//! genuinely worth not writing — in `cookie_store`.

use cookie_store::{CookieStore, RawCookie};
use reqwest::header::HeaderValue;
use std::sync::{Mutex, MutexGuard, PoisonError};
use url::Url;

/// A `CookieStore` behind a mutex, shareable across the concurrent requests a
/// reqwest `Client` may have in flight.
#[derive(Debug, Default)]
pub struct Jar(Mutex<CookieStore>);

impl Jar {
    pub fn lock(
        &self,
    ) -> Result<MutexGuard<'_, CookieStore>, PoisonError<MutexGuard<'_, CookieStore>>> {
        self.0.lock()
    }
}

impl reqwest::cookie::CookieStore for Jar {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        let parsed = headers.filter_map(|value| {
            std::str::from_utf8(value.as_bytes())
                .ok()
                .and_then(|text| RawCookie::parse(text).ok())
                .map(|cookie| cookie.into_owned())
        });
        // A malformed Set-Cookie is skipped rather than failing the response:
        // servers do emit them, and losing the response over one is worse than
        // losing the cookie.
        if let Ok(mut store) = self.0.lock() {
            store.store_response_cookies(parsed, url);
        }
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        let store = self.0.lock().ok()?;
        let header = store
            .get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        if header.is_empty() {
            return None;
        }
        HeaderValue::from_str(&header).ok()
    }
}
