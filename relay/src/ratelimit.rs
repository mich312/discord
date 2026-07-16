//! Per-client token-bucket rate limiting for the unauthenticated surface:
//! the pre-auth account endpoints (online password guessing, username
//! enumeration) and new WebSocket connections (handshake spam). Deliberately
//! dependency-free and in-memory — limits are per relay process, which
//! matches how the relay deploys (single container).

use axum::http::HeaderMap;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Instant;

pub struct RateLimiter {
    /// Tokens added per second.
    rate: f64,
    /// Bucket capacity (burst size).
    burst: f64,
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

impl RateLimiter {
    pub fn per_minute(per_minute: u32) -> Self {
        Self {
            rate: f64::from(per_minute) / 60.0,
            burst: f64::from(per_minute),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Take one token for `key`; false = over the limit right now.
    pub fn allow(&self, key: IpAddr) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        // Cheap unbounded-growth guard: full buckets are indistinguishable
        // from absent ones, so drop them whenever the map gets large.
        if buckets.len() > 10_000 {
            let (rate, burst) = (self.rate, self.burst);
            buckets.retain(|_, (tokens, last)| {
                (*tokens + now.duration_since(*last).as_secs_f64() * rate) < burst
            });
        }
        let (tokens, last) = buckets.entry(key).or_insert((self.burst, now));
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.rate).min(self.burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// The client address the limits key on. The socket peer address by
/// default; with TRUST_PROXY=1 (the relay sits behind Caddy/nginx, which
/// overwrites the header) the first hop in X-Forwarded-For. Never trust
/// the header without a proxy in front — it is client-controlled.
pub fn client_ip(trust_proxy: bool, headers: &HeaderMap, peer: Option<SocketAddr>) -> IpAddr {
    if trust_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok())
        {
            return ip;
        }
    }
    peer.map(|a| a.ip()).unwrap_or(IpAddr::from([0, 0, 0, 0]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_empties_and_refills() {
        let limiter = RateLimiter::per_minute(3);
        let ip = IpAddr::from([10, 0, 0, 1]);
        assert!(limiter.allow(ip));
        assert!(limiter.allow(ip));
        assert!(limiter.allow(ip));
        assert!(!limiter.allow(ip), "burst spent");
        // Another client has its own bucket.
        assert!(limiter.allow(IpAddr::from([10, 0, 0, 2])));
        // Manually refill past one token's worth of time.
        {
            let mut buckets = limiter.buckets.lock().unwrap();
            let entry = buckets.get_mut(&ip).unwrap();
            entry.1 = Instant::now() - std::time::Duration::from_secs(21);
        }
        assert!(limiter.allow(ip), "a token accrues after rate seconds");
        assert!(!limiter.allow(ip));
    }

    #[test]
    fn forwarded_header_only_with_trust() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        let peer = Some(SocketAddr::from(([192, 168, 1, 5], 4242)));
        assert_eq!(client_ip(false, &headers, peer), IpAddr::from([192, 168, 1, 5]));
        assert_eq!(client_ip(true, &headers, peer), IpAddr::from([203, 0, 113, 9]));
        assert_eq!(client_ip(true, &HeaderMap::new(), peer), IpAddr::from([192, 168, 1, 5]));
    }
}
