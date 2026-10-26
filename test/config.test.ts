// Configuration is read from the environment before anything else happens, so its rules are
// the first thing a misconfigured deployment meets. The interesting one: a console reachable
// from the network must not be guarded by the password that ships in the repository.

import assert from "node:assert/strict";
import test from "node:test";
import { exposedToNetwork, loadConfig } from "../src/config.js";

const plain = {};

test("defaults are a loopback gateway with the shipped console password", () => {
  const config = loadConfig(plain);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.strategy, "round-robin");
  assert.equal(config.port, 8787);
  assert.equal(config.dashboardPassword, "admin");
  assert.equal(exposedToNetwork(config.host), false);
});

test("a placeholder password is refused once the console leaves loopback", () => {
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0" }),
    /DASHBOARD_PASSWORD is still the placeholder "admin"/,
  );
  assert.throws(
    () => loadConfig({ HOST: "10.0.0.5", DASHBOARD_PASSWORD: "changeme" }),
    /placeholder "changeme" while HOST is 10\.0\.0\.5/,
  );
});

test("an empty password is treated as unset, never as a password", () => {
  assert.throws(() => loadConfig({ HOST: "0.0.0.0", DASHBOARD_PASSWORD: "" }), /placeholder "admin"/);
  assert.throws(() => loadConfig({ HOST: "0.0.0.0", DASHBOARD_PASSWORD: "   " }), /placeholder "admin"/);
  assert.equal(loadConfig({ DASHBOARD_PASSWORD: "" }).dashboardPassword, "admin");
  assert.equal(loadConfig({ DASHBOARD_PASSWORD: "  spaced  " }).dashboardPassword, "  spaced  ");
});

test("a real password, or a loopback bind, is accepted", () => {
  assert.equal(loadConfig({ HOST: "0.0.0.0", DASHBOARD_PASSWORD: "9f4c1a2e-long-and-boring" }).host, "0.0.0.0");
  assert.equal(loadConfig({ HOST: "localhost" }).dashboardUser, "admin");
  assert.equal(loadConfig({ HOST: "127.0.0.1", DASHBOARD_PASSWORD: "admin" }).dashboardPassword, "admin");
});

test("only the loopback spellings count as local", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
    assert.equal(exposedToNetwork(host), false, `${host} is loopback`);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "gateway.internal", "127.0.0.1.example.com"]) {
    assert.equal(exposedToNetwork(host), true, `${host} is not loopback`);
  }
});

test("numbers must be numbers, and the routing strategy must be one we have", () => {
  assert.throws(() => loadConfig({ PORT: "http" }), /PORT must be a number/);
  assert.throws(() => loadConfig({ MAX_ATTEMPTS: "0" }), /MAX_ATTEMPTS must be a number >= 1/);
  assert.throws(() => loadConfig({ ROUTING: "random" }), /ROUTING must be round-robin or least-used/);
  assert.equal(loadConfig({ ROUTING: "least-used" }).strategy, "least-used");
});
