import assert from "node:assert/strict";
import apiVersionHelpers from "../server/api-version.cjs";

const { API_VERSION, isSupportedApi } = apiVersionHelpers;

assert.equal(API_VERSION, 8);
assert.equal(isSupportedApi({ service: "review-annotation-api", apiVersion: API_VERSION }), true);
assert.equal(isSupportedApi({ service: "review-annotation-api", apiVersion: API_VERSION - 1 }), false);
assert.equal(isSupportedApi({ service: "other-service", apiVersion: API_VERSION }), false);
assert.equal(isSupportedApi(null), false);

console.log("api-version.test.mjs passed");
