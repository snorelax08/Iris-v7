
(function () {
  "use strict";

  // Keep your existing PostHog Project API token here.
  const POSTHOG_KEY = "phc_rVP7k3RMbWSJb8pgFaXsGgiA79Xxyxw74vEp3wMhWxKd".trim();

  const API_HOST = "https://us.i.posthog.com";
  const PLACEHOLDER = "PASTE_YOUR_EXISTING_POSTHOG_PROJECT_TOKEN_HERE";

  if (!POSTHOG_KEY || POSTHOG_KEY === PLACEHOLDER) {
    console.warn("[Iris Analytics] Project token not configured.");

    const noOp = function () {};

    window.IrisAnalytics = Object.freeze({
      capture: noOp,
      optIn: noOp,
      optOut: noOp,
      getConsentStatus: function () {
        return "pending";
      }
    });

    return;
  }

  // PostHog official browser SDK loader.
  !function (t, e) {
    var o, n, p, r;

    e.__SV || (
      window.posthog = e,
      e._i = [],

      e.init = function (i, s, a) {
        function g(t, e) {
          var o = e.split(".");
          2 === o.length && (t = t[o[0]], e = o[1]);

          t[e] = function () {
            t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
          };
        }

        (p = t.createElement("script")).type = "text/javascript";
        p.crossOrigin = "anonymous";
        p.async = true;

        p.src = s.api_host.replace(
          ".i.posthog.com",
          "-assets.i.posthog.com"
        ) + "/static/array.js";

        r = t.getElementsByTagName("script")[0];

        if (r && r.parentNode) {
          r.parentNode.insertBefore(p, r);
        } else {
          t.head.appendChild(p);
        }

        var u = e;

        if (typeof a !== "undefined") {
          u = e[a] = [];
        } else {
          a = "posthog";
        }

        u.people = u.people || [];

        Object.defineProperty(u, "toString", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: function (t) {
            var e = "posthog";

            if (a !== "posthog") {
              e += "." + a;
            }

            if (!t) {
              e += " (stub)";
            }

            return e;
          }
        });

        Object.defineProperty(u.people, "toString", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: function () {
            return u.toString(1) + ".people (stub)";
          }
        });

        o = (
          "init capture register register_once register_for_session " +
          "unregister unregister_for_session getFeatureFlag " +
          "getFeatureFlagResult isFeatureEnabled reloadFeatureFlags " +
          "updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures " +
          "on onFeatureFlags onSessionId identify " +
          "setPersonProperties group resetGroups " +
          "setPersonPropertiesForFlags resetPersonPropertiesForFlags " +
          "setGroupPropertiesForFlags resetGroups " +
          "reset get_distinct_id getGroups get_session_id " +
          "get_session_replay_url alias set_config " +
          "startSessionRecording stopSessionRecording " +
          "sessionRecordingStarted captureException loadToolbar " +
          "get_property getSessionProperty createPersonProfile " +
          "opt_in_capturing opt_out_capturing " +
          "clear_opt_in_out_capturing " +
          "has_opted_in_capturing has_opted_out_capturing " +
          "get_explicit_consent_status is_capturing debug"
        ).split(" ");

        for (n = 0; n < o.length; n++) {
          g(u, o[n]);
        }

        e._i.push([i, s, a]);
      },

      e.__SV = 1
    );

  }(document, window.posthog || []);

  // Initialize PostHog.
  window.posthog.init(POSTHOG_KEY, {
    api_host: API_HOST,
    defaults: "2026-08-30",

    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,

    disable_session_recording: true,

    // Enable analytics by default for the private beta.
    opt_out_capturing_by_default: false
  });

  // One-time migration for browsers that were previously opted out
  // because of the old opt_out_capturing_by_default setting.
  const MIGRATION_KEY = "iris_beta_analytics_migration_v1";

  function migrateLegacyOptOut() {
    let alreadyMigrated = false;

    try {
      alreadyMigrated =
        localStorage.getItem(MIGRATION_KEY) === "done";
    } catch (error) {
      console.warn("[Iris Analytics] Could not read migration status.");
    }

    if (alreadyMigrated) return;

    try {
      if (
        window.posthog &&
        typeof window.posthog.clear_opt_in_out_capturing === "function"
      ) {
        window.posthog.clear_opt_in_out_capturing();
      }
    } catch (error) {
      console.warn("[Iris Analytics] Legacy preference migration failed.");
      return;
    }

    try {
      localStorage.setItem(MIGRATION_KEY, "done");
    } catch (error) {
      console.warn("[Iris Analytics] Could not save migration status.");
    }
  }

  migrateLegacyOptOut();

  // Only these approved events and properties can be captured.
  const allowed = {
    app_opened: [
      "app_version",
      "environment",
      "speech_locale"
    ],

    spotify_auth_succeeded: [
      "auth_method"
    ],

    spotify_auth_failed: [
      "error_code"
    ],

    player_ready: [
      "player_type"
    ],

    player_error: [
      "error_code",
      "error_stage"
    ],

    voice_session_started: [
      "input_mode",
      "speech_locale"
    ],

    voice_session_ended: [
      "end_reason"
    ],

    voice_command_received: [
      "command_id",
      "command_category",
      "input_mode",
      "speech_locale"
    ],

    intent_parsed: [
      "command_id",
      "intent_type",
      "parse_status"
    ],

    song_search_completed: [
      "command_id",
      "outcome",
      "latency_ms",
      "confidence_bucket",
      "candidate_count",
      "used_llm_fallback"
    ],

    song_option_selected: [
      "command_id",
      "selection_position",
      "selection_method"
    ],

    playback_attempted: [
      "command_id",
      "playback_method"
    ],

    playback_started: [
      "command_id",
      "time_to_playback_ms"
    ],

    playback_failed: [
      "command_id",
      "error_code",
      "playback_method"
    ],

    command_action_completed: [
      "command_id",
      "command_category",
      "success"
    ]
  };

  // Capture only approved events with approved properties.
  function capture(eventName, properties) {
    if (!Object.prototype.hasOwnProperty.call(allowed, eventName)) {
      return;
    }

    const safe = {};
    const input = properties || {};

    allowed[eventName].forEach(function (key) {
      const value = input[key];

      if (typeof value === "string" && value.length <= 80) {
        safe[key] = value;
      } else if (
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        safe[key] = value;
      } else if (typeof value === "boolean") {
        safe[key] = value;
      }
    });

    try {
      if (
        window.posthog &&
        typeof window.posthog.capture === "function"
      ) {
        window.posthog.capture(eventName, safe);
      }
    } catch (error) {
      console.warn("[Iris Analytics] Event could not be captured.");
    }
  }

  // Public analytics interface for Iris.
  window.IrisAnalytics = Object.freeze({

    capture: capture,

    optIn: function () {
      if (window.posthog) {
        window.posthog.opt_in_capturing({
          captureEventName: false
        });
      }
    },

    optOut: function () {
      if (window.posthog) {
        window.posthog.opt_out_capturing();
      }
    },

    getConsentStatus: function () {
      if (
        window.posthog &&
        typeof window.posthog.get_explicit_consent_status === "function"
      ) {
        return window.posthog.get_explicit_consent_status() || "pending";
      }

      return "pending";
    }

  });

  console.log("[Iris Analytics] Initialized successfully.");

})();
