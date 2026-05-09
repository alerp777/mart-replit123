/* AJKMart Vendor App — SW v3 (network-first, no caching) */
/* Clears all old caches on install/activate so stale assets never persist. */
/* Push-notification handlers show system notifications for background orders. */

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Network-first: all requests go straight to the network — no caching. */
self.addEventListener("fetch", function (e) {
  e.respondWith(
    fetch(e.request).catch(function () {
      return new Response("Offline", { status: 503 });
    })
  );
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "New Order Received", body: event.data ? event.data.text() : "" };
  }

  var title = data.title || "New Order Received";
  var options = {
    body: data.body || "You have a new order. Tap to view.",
    icon: "/vendor/favicon.svg",
    badge: "/vendor/favicon.svg",
    tag: data.tag || "ajkmart-vendor-order",
    renotify: true,
    requireInteraction: true,
    data: data.data || {},
    actions: [
      { action: "view-orders", title: "View Orders" },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  /* Derive the app base from the service worker registration scope so click
     navigation works whether the vendor app is served at /vendor/, /app/, or
     root (/). The scope is always a full URL (e.g. https://host/vendor/) so
     we use startsWith(swScope) for matching — this is safe even when the app
     is at root because the trailing slash prevents false matches on unrelated
     tabs that share only the origin. */
  var swScope = (self.registration && self.registration.scope) || (self.location.origin + "/");
  var base = swScope.replace(/\/$/, "");

  var orderId = (event.notification.data && event.notification.data.orderId)
    ? event.notification.data.orderId
    : null;
  var targetPath = orderId ? base + "/orders/" + orderId : base + "/orders";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      /* Look for an existing tab that falls within the SW's registered scope.
         Using startsWith(swScope) is precise — it matches /vendor/orders but
         not /admin/ even if both are same-origin. */
      var vendorClient = null;
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url && c.url.startsWith(swScope)) {
          vendorClient = c;
          break;
        }
      }
      if (vendorClient) {
        /* Focus the existing tab and post a message to navigate it */
        return vendorClient.focus().then(function (fc) {
          if (!fc) return;
          if (fc.navigate) {
            return fc.navigate(targetPath);
          }
          /* Fallback: post a message so the app can handle navigation */
          fc.postMessage({ type: "SW_NAVIGATE", path: targetPath });
        });
      }
      /* No existing vendor tab — open a new one */
      return clients.openWindow(targetPath);
    })
  );
});
