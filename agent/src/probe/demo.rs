use super::Probe;
use serde_json::{json, Value};

#[derive(Default)]
pub struct DemoProbe {
    index: usize,
}

impl Probe for DemoProbe {
    fn measure(&mut self, mode: &str) -> Result<Value, String> {
        if mode.eq_ignore_ascii_case("light") {
            return Ok(
                json!({"mode":"LIGHT","download":null,"upload":null,"ping":34.0,"jitter":6.0,"packet_loss":0.1,"availability":100.0,"connection_status":"OK","raw":{"probe":"demo","kind":"light"}}),
            );
        }
        let samples = [
            (96.0, 94.0, 32.0, 8.0, 0.2),
            (43.0, 39.0, 48.0, 12.0, 0.8),
            (39.0, 37.0, 52.0, 14.0, 1.0),
            (41.0, 38.0, 49.0, 13.0, 0.9),
        ];
        let (download, upload, ping, jitter, loss) = samples[self.index.min(samples.len() - 1)];
        self.index += 1;
        Ok(
            json!({"mode":"PERFORMANCE","download":download,"upload":upload,"ping":ping,"jitter":jitter,"packet_loss":loss,"availability":100.0,"connection_status":"OK","raw":{"probe":"demo","sequence":self.index}}),
        )
    }
}
