const API_VERSION = 8;

function isSupportedApi(health) {
  return health?.service === "review-annotation-api" && Number(health.apiVersion) >= API_VERSION;
}

module.exports = { API_VERSION, isSupportedApi };
