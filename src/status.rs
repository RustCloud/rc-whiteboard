//! `GET /status`: the report the plugin dialog (Administration → Plugins →
//! Whiteboard → Status) shows: whether the service is set and answers, and
//! whether its version goes with the plugin's.

use serde_json::json;

use crate::backend::{Backend, Reply};
use crate::session::{Settings, SERVICE_PATH};
use crate::web;

/// The plugin's version: the service of the same `major.minor` serves a board
/// that talks to these routes.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// One line of the report: a level and the text by language.
fn line(level: &str, en: String, ru: String) -> serde_json::Value {
    json!({ "level": level, "text": { "en": en, "ru": ru } })
}

pub fn status(backend: &dyn Backend) -> Reply {
    web::json(200, serde_json::Value::Array(report(backend)))
}

fn report(backend: &dyn Backend) -> Vec<serde_json::Value> {
    let Some(service_url) = Settings::of(backend).service_url else {
        return vec![line(
            "error",
            "The address of the whiteboard service is not set (Settings tab).".into(),
            "Не задан адрес сервиса доски (вкладка «Настройки»).".into(),
        )];
    };
    let url = format!("{service_url}{SERVICE_PATH}version");
    let answer = match backend.fetch(&url) {
        Ok(answer) if answer.status == 200 => answer,
        Ok(answer) => {
            return vec![line(
                "error",
                format!(
                    "The whiteboard service at {service_url} answers {}: is it the whiteboard service?",
                    answer.status
                ),
                format!("Сервис доски по адресу {service_url} отвечает {}: это точно сервис доски?", answer.status),
            )]
        }
        Err(why) => {
            return vec![line(
                "error",
                format!("The whiteboard service does not answer at {service_url}: {why}"),
                format!("Сервис доски не отвечает по адресу {service_url}: {why}"),
            )]
        }
    };
    let version = serde_json::from_slice::<serde_json::Value>(&answer.body)
        .ok()
        .and_then(|info| info["version"].as_str().map(str::to_owned));
    let Some(version) = version else {
        return vec![line(
            "error",
            format!("{url} answers, but not as the whiteboard service."),
            format!("По адресу {url} отвечает что-то другое, не сервис доски."),
        )];
    };
    let mut lines = vec![line(
        "ok",
        format!("Whiteboard service {version} answers at {service_url}"),
        format!("Сервис доски {version} отвечает по адресу {service_url}"),
    )];
    if minor(&version) != minor(VERSION) {
        lines.push(line(
            "warning",
            format!("The plugin is {VERSION}, the service {version}: update them to the same version."),
            format!("Версия плагина {VERSION}, сервиса — {version}: обновите их до одной версии."),
        ));
    }
    lines
}

/// `major.minor` of a version.
fn minor(version: &str) -> String {
    version.split('.').take(2).collect::<Vec<_>>().join(".")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::fake::Fake;
    use crate::backend::Fetched;

    const VERSION_URL: &str = "http://whiteboard.test:8080/whiteboard/version";

    fn report_of(fake: &Fake) -> Vec<serde_json::Value> {
        serde_json::from_slice(&status(fake).body).unwrap()
    }

    fn answers(fake: &Fake, status: u16, body: &str) {
        fake.web.borrow_mut().insert(VERSION_URL.into(), Ok(Fetched { status, body: body.as_bytes().to_vec() }));
    }

    fn has(lines: &[serde_json::Value], level: &str, en: &str) -> bool {
        lines.iter().any(|line| line["level"] == level && line["text"]["en"].as_str().unwrap().contains(en))
    }

    #[test]
    fn service_answers() {
        let fake = Fake::user();
        answers(&fake, 200, &format!(r#"{{"name":"rc-whiteboard-service","version":"{VERSION}"}}"#));
        let lines = report_of(&fake);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(has(&lines, "ok", "answers at http://whiteboard.test:8080"));
        assert!(lines.iter().all(|line| line["text"]["ru"].is_string()));
    }

    #[test]
    fn warns_of_another_version() {
        let fake = Fake::user();
        answers(&fake, 200, r#"{"version":"9.9.0"}"#);
        assert!(has(&report_of(&fake), "warning", "the service 9.9.0"));
    }

    #[test]
    fn reports_failures() {
        let unset = Fake { settings: json!({ "service_url": "" }), ..Fake::user() };
        assert!(has(&report_of(&unset), "error", "not set"));
        assert!(has(&report_of(&Fake::user()), "error", "does not answer"));
        let other = Fake::user();
        answers(&other, 404, "nope");
        assert!(has(&report_of(&other), "error", "answers 404"));
        answers(&other, 200, "<html>");
        assert!(has(&report_of(&other), "error", "not as the whiteboard service"));
    }
}
