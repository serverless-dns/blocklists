/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// a simple logger that prints time on every output
const E = "E/";
const W = "W/";
const I = "I/";
const D = "D/";

export function d(...args) {
  console.debug(t(), D, ...args);
}

export function i(...args) {
  console.info(t(), I, ...args);
}

export function w(...args) {
  console.warn(t(), W, ...args);
}

export function e(...args) {
  console.error(t(), E, ...args);
}

function t() {
  return new Date().toISOString();
}
