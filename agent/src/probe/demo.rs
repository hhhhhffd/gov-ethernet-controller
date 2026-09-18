use super::Probe;
use serde_json::{json, Value};

#[derive(Default)]
pub struct DemoProbe {
    index: usize,
}

impl Probe for DemoProbe {
    fn measure(&mut self, mode: &str) -> Result<Value, String> {
        if mode.eq_ignore_ascii_case("light") {
            return Ok(json!({
                "mode":"LIGHT",
                "download":null,
                "upload":null,
                "ping":34.0,
                "jitter":6.0,
                "packet_loss":0.1,
                "availability":100.0,
                "connection_status":"OK",
                "quality":"VALID",
                "latency_method":"DEMO",
                "raw":{
                    "probe":"demo",
                    "kind":"light",
                    "latency_method":"DEMO",
                    "latency_evidence":{"method":"DEMO","sample_count":1,"attempt_count":1,"successful_count":1,"samples_ms":[34.0]},
                    "availability_observation":"REACHABLE",
                    "availability_aggregation":"server_period_sampled_observations",
                    "availability_attempt_count":1,
                    "availability_success_count":1
                }
            }));
        }
        let samples = [
            (96.0, 94.0, 32.0, 8.0, 0.2),
            (43.0, 39.0, 48.0, 12.0, 0.8),
            (39.0, 37.0, 52.0, 14.0, 1.0),
            (41.0, 38.0, 49.0, 13.0, 0.9),
        ];
        let (download, upload, ping, jitter, loss) = samples[self.index.min(samples.len() - 1)];
        self.index += 1;
        Ok(json!({
            "mode":"PERFORMANCE",
            "download":download,
            "upload":upload,
            "ping":ping,
            "jitter":jitter,
            "packet_loss":loss,
            "availability":100.0,
            "connection_status":"OK",
            "quality":"VALID",
            "latency_method":"DEMO",
            "raw":{
                "probe":"demo",
                "sequence":self.index,
                "latency_method":"DEMO",
                "latency_evidence":{"method":"DEMO","sample_count":1,"attempt_count":1,"successful_count":1,"samples_ms":[ping]},
                "availability_observation":"REACHABLE",
                "availability_aggregation":"server_period_sampled_observations",
                "availability_attempt_count":1,
                "availability_success_count":1
            }
        }))
    }
}
