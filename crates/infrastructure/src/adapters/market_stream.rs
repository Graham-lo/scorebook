//! One public stream per active contract, shared by every watch in this process.
//! Buffers have hard byte/event/idle limits and cannot be serialized or persisted.
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
#[derive(Clone, Default)]
pub struct MarketStreams {
    entries: Arc<Mutex<HashMap<String, Arc<Entry>>>>,
}
struct Entry {
    buffer: Mutex<Buffer>,
    running: AtomicBool,
}
struct Buffer {
    rows: VecDeque<(Value, usize)>,
    bytes: usize,
    last_used: Instant,
}
impl MarketStreams {
    pub fn trades(
        &self,
        market: &str,
        symbol: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Option<Value> {
        if start >= end
            || (end - start).num_seconds() > 300
            || end < Utc::now() - chrono::Duration::minutes(2)
        {
            return None;
        }
        if crate::application::history_catalog::validate_symbol(symbol).is_err() {
            return None;
        }
        let prefix = match market {
            "usd_m" => "wss://fstream.binance.com/market/ws/",
            "coin_m" => "wss://dstream.binance.com/ws/",
            _ => return None,
        };
        let key = format!("{market}:{symbol}");
        let mut map = self.entries.lock().unwrap();
        map.retain(|_, e| e.buffer.lock().unwrap().last_used.elapsed() < Duration::from_secs(120));
        if !map.contains_key(&key) && map.len() >= 32 {
            return None;
        }
        let entry = map
            .entry(key)
            .or_insert_with(|| {
                Arc::new(Entry {
                    buffer: Mutex::new(Buffer {
                        rows: VecDeque::new(),
                        bytes: 0,
                        last_used: Instant::now(),
                    }),
                    running: AtomicBool::new(false),
                })
            })
            .clone();
        drop(map);
        entry.buffer.lock().unwrap().last_used = Instant::now();
        if !entry.running.swap(true, Ordering::SeqCst) {
            let e = entry.clone();
            let url = format!("{prefix}{}@aggTrade", symbol.to_lowercase());
            tokio::spawn(async move {
                run(e, url).await;
            });
        }
        let b = entry.buffer.lock().unwrap();
        let first = b.rows.front()?.0["T"].as_i64()?;
        let last = b.rows.back()?.0["T"].as_i64()?;
        // Both sides must be bracketed by a continuously sequenced stream. A socket
        // merely being connected is never evidence that an interval is complete.
        if first >= start.timestamp_millis() || last <= end.timestamp_millis() {
            return None;
        }
        let raw: Vec<_> = b
            .rows
            .iter()
            .filter(|(r, _)| {
                r["T"]
                    .as_i64()
                    .is_some_and(|t| t >= start.timestamp_millis() && t <= end.timestamp_millis())
            })
            .map(|r| r.0.clone())
            .collect();
        Some(
            json!({"provider":"binance","market":market,"instrument":symbol,"requested_start":start,"requested_end":end,"received_at":Utc::now(),"coverage_complete":true,"raw":raw,"price_type":"trade","identity":"historical_reconstruction"}),
        )
    }
}
async fn run(entry: Arc<Entry>, url: String) {
    let mut delay = 1u64;
    loop {
        if entry.buffer.lock().unwrap().last_used.elapsed() > Duration::from_secs(120) {
            break;
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(64 * 1024))
            .max_frame_size(Some(64 * 1024));
        let socket = tokio::time::timeout(
            Duration::from_secs(10),
            connect_async_with_config(&url, Some(config), false),
        )
        .await;
        #[cfg(test)]
        match &socket { Err(_) => eprintln!("public WebSocket connect timeout"), Ok(Err(e)) => eprintln!("public WebSocket connect error: {e}"), _ => () }
        if let Ok(Ok((mut socket, _))) = socket {
            {
                let mut b = entry.buffer.lock().unwrap();
                b.rows.clear();
                b.bytes = 0;
            }
            let mut check = tokio::time::interval(Duration::from_secs(5));
            let started = Instant::now();
            loop {
                tokio::select! {
                 _=check.tick()=>{if entry.buffer.lock().unwrap().last_used.elapsed()>Duration::from_secs(120)||started.elapsed()>Duration::from_secs(23*3600){break;}},
                 message=socket.next()=>{match message{
                  Some(Ok(Message::Text(text)))=>{
                   let Ok(v)=serde_json::from_str::<Value>(&text)else{break};
                   if v["e"]!="aggTrade"{continue;}
                   let(Some(id),Some(at),Some(price))=(v["a"].as_i64(),v["T"].as_i64(),v["p"].as_str())else{break};
                   if scorebook_core::domain::criteria::dec(price).map_or(true,|v|v<=0){break;}
                   let mut obj=serde_json::Map::new();for key in ["a","p","q","f","l","T","m"]{if let Some(v)=v.get(key){obj.insert(key.into(),v.clone());}}
                   let row=Value::Object(obj);let bytes=text.len();let mut b=entry.buffer.lock().unwrap();
                   if let Some((last,_))=b.rows.back(){
                    if last["a"]==id&&last==&row{continue;}
                    if last["a"].as_i64().is_none_or(|p|id!=p+1)||last["T"].as_i64().is_none_or(|t|at<t){b.rows.clear();b.bytes=0;}
                   }
                   b.bytes+=bytes;b.rows.push_back((row,bytes));
                   while b.bytes>2*1024*1024||b.rows.len()>10000||b.rows.front().is_some_and(|r|r.0["T"].as_i64().is_some_and(|t|t<at-90000)){if let Some((_,n))=b.rows.pop_front(){b.bytes-=n;}else{break;}}
                   delay=1;
                  },
                  Some(Ok(Message::Ping(p)))=>{match socket.send(Message::Pong(p)).await {Ok(())=>(),Err(_)=>break}},
                  Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                  _=>{},
                 }}
                }
            }
            let _ = socket.close(None).await;
        }
        {
            let mut b = entry.buffer.lock().unwrap();
            b.rows.clear();
            b.bytes = 0;
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(30);
    }
    entry.running.store(false, Ordering::SeqCst);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "explicit live public Binance WebSocket acceptance; RAM only"]
    async fn live_routed_usdm_stream_brackets_interval() {
        let streams = MarketStreams::default();
        let started = Utc::now();
        // Establish the stream before the interval whose completeness we test.
        streams.trades(
            "usd_m",
            "BTCUSDT",
            started - chrono::Duration::seconds(1),
            started,
        );
        let mut found = None;
        for _ in 0..40 {
            let now = Utc::now();
            found = streams.trades(
                "usd_m",
                "BTCUSDT",
                started + chrono::Duration::seconds(5),
                now - chrono::Duration::seconds(2),
            );
            if found.is_some() && now > started + chrono::Duration::seconds(10) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let found = found.expect("routed market WebSocket did not prove a continuous interval");
        assert_eq!(found["coverage_complete"], true);
        assert!(!found["raw"].as_array().unwrap().is_empty());
    }
}
