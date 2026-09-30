//! A cookie jar for reqwest.
//!
//! `cookie_store` implements the hard part (domain and path matching, expiry,
//! `Secure`/`HttpOnly`, public-suffix rules) and reqwest defines a two-method
//! trait for plugging a jar in. This module is the ~40 lines that join them.
//!
//! `reqwest_cookie_store` does the same, but it pins a reqwest version, and a
//! mismatch links two copies of reqwest with the trait implemented for the
//! wrong one. Owning these lines avoids that lockstep while the cookie
//! semantics stay in `cookie_store`.

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
