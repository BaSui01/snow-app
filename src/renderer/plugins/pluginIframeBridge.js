(function () {
  "use strict";

  var config = __SNOW_PLUGIN_CONFIG__;
  var pending = new Map();
  var subscriptions = new Map();
  var listeners = new Map();
  var nextId = 1;
  var host = window.parent;

  function post(message) {
    host.postMessage(message, "*");
  }

  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ source: "snow-plugin", id: id, type: type, payload: payload });
    });
  }

  function interpolate(template, values) {
    if (!values) {
      return template;
    }
    return String(template).replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      function (match, key) {
        return Object.prototype.hasOwnProperty.call(values, key)
          ? String(values[key])
          : match;
      },
    );
  }

  function emit(event, payload) {
    var handlers = listeners.get(event) || [];
    handlers.slice().forEach(function (handler) {
      try {
        handler(payload);
      } catch (error) {
        console.error(error);
      }
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      data.source !== "snow-plugin-host"
    ) {
      return;
    }
    if (data.type === "response") {
      var entry = pending.get(data.id);
      if (!entry) {
        return;
      }
      pending.delete(data.id);
      if (data.ok) {
        entry.resolve(data.result);
      } else {
        entry.reject(new Error(data.error || "Plugin request failed"));
      }
      return;
    }
    if (data.type === "metadata") {
      var subscription = subscriptions.get(data.subscriptionId);
      if (subscription) {
        subscription(data.payload);
      }
      return;
    }
    if (data.type === "event") {
      emit(data.event, data.payload);
    }
  });

  var api = {
    runtime: "iframe",
    plugin: { id: config.pluginId, name: config.name, version: config.version },
    locale: config.locale,
    t: function (key, options) {
      var template =
        (config.messages && config.messages[key]) ||
        (options && options.defaultValue) ||
        key;
      return interpolate(template, options && options.values);
    },
    metadata: {
      get: function (domain, options) {
        return request("metadata.get", { domain: domain, options: options });
      },
      domains: function () {
        return request("metadata.domains", {});
      },
      subscribe: function (domain, listener, options) {
        return request("metadata.subscribe", {
          domain: domain,
          options: options,
        }).then(function (result) {
          subscriptions.set(result.subscriptionId, listener);
          return {
            unsubscribe: function () {
              subscriptions.delete(result.subscriptionId);
              return request("metadata.unsubscribe", {
                subscriptionId: result.subscriptionId,
              });
            },
          };
        });
      },
    },
    write: {
      run: function (actionId, params) {
        return request("write.run", { action: actionId, params: params });
      },
      domains: function () {
        return request("write.domains", {});
      },
    },
    storage: {
      get: function (key) {
        return request("storage.get", { key: key });
      },
      set: function (key, value) {
        return request("storage.set", { key: key, value: value });
      },
      remove: function (key) {
        return request("storage.remove", { key: key });
      },
      all: function () {
        return request("storage.all", {});
      },
    },
    assets: {
      resolve: function (relativePath) {
        return request("assets.resolve", { path: relativePath });
      },
    },
    on: function (event, handler) {
      var handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return function () {
        var current = listeners.get(event) || [];
        listeners.set(
          event,
          current.filter(function (item) {
            return item !== handler;
          }),
        );
      };
    },
    log: function () {
      var args = Array.prototype.slice.call(arguments);
      console.log.apply(
        console,
        ["[plugin:" + config.pluginId + "]"].concat(args),
      );
    },
  };

  Object.defineProperty(window, "SnowPlugin", {
    value: api,
    writable: false,
    configurable: false,
  });
})();
