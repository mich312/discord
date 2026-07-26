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

    /// Bucket key for an address. A single IPv6 allocation is routinely a
    /// /64 — 2^64 addresses — so keying on the full address let one host
    /// mint a fresh bucket per request and walk straight through every
    /// limit. Collapse v6 to its /64; v4 is used whole.
    fn bucket_key(ip: IpAddr) -> IpAddr {
        match ip {
            IpAddr::V6(v6) => {
                let o = v6.octets();
                let mut prefix = [0u8; 16];
                prefix[..8].copy_from_slice(&o[..8]);
                IpAddr::from(prefix)
            }
            v4 => v4,
        }
    }

    /// Take one token for `key`; false = over the limit right now.
    pub fn allow(&self, key: IpAddr) -> bool {
        let key = Self::bucket_key(key);
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
            // The LAST hop is the one our own proxy appended. nginx's
            // stock $proxy_add_x_forwarded_for APPENDS to whatever the
            // client sent, so trusting the first hop let any client spoof
            // its rate-limit identity by sending its own header.
            .and_then(|v| v.split(',').next_back())
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

#[cfg(test)]
mod prefix_tests {
    use super::*;

    #[test]
    fn ipv6_addresses_in_one_slash_64_share_a_bucket() {
        // A /64 is a routine single allocation. Keying on the full address
        // gave one host 2^64 buckets and so no limit at all.
        let limiter = RateLimiter::per_minute(1);
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff:ffff:ffff:ffff".parse().unwrap();
        assert!(limiter.allow(a), "first request in the /64 is allowed");
        assert!(!limiter.allow(b), "a different address in the same /64 must not reset it");

        // A genuinely different /64 is still its own bucket.
        let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert!(limiter.allow(other));
    }

    #[test]
    fn ipv4_addresses_are_bucketed_whole() {
        let limiter = RateLimiter::per_minute(1);
        assert!(limiter.allow("198.51.100.7".parse().unwrap()));
        assert!(!limiter.allow("198.51.100.7".parse().unwrap()));
        assert!(limiter.allow("198.51.100.8".parse().unwrap()), "a different v4 host is separate");
    }

    #[test]
    fn the_trusted_forwarded_hop_is_the_last_one() {
        // nginx's stock $proxy_add_x_forwarded_for appends, so the hop our
        // own proxy added is the last. Trusting the first let a client
        // choose its own rate-limit identity.
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 198.51.100.4".parse().unwrap());
        assert_eq!(
            client_ip(true, &headers, None),
            "198.51.100.4".parse::<IpAddr>().unwrap(),
            "the spoofed leading hop must be ignored"
        );
    }
}
