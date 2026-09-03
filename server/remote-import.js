import { promises as dns } from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_REDIRECT_LIMIT = 5;

export async function downloadRemoteDocument({
  url,
  destination,
  maxBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  redirectLimit = DEFAULT_REDIRECT_LIMIT,
  allowPrivate = false
}) {
  const requestedUrl = parseRemoteDocumentUrl(url);
  let currentUrl = requestedUrl;

  for (let redirectCount = 0; redirectCount <= redirectLimit; redirectCount += 1) {
    const response = await openRemoteResponse(currentUrl, { timeoutMs, allowPrivate });
    const status = Number(response.statusCode || 0);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw remoteImportError("remote_redirect_invalid", "文件链接返回了无效的跳转地址。", 422);
      if (redirectCount === redirectLimit) throw remoteImportError("remote_redirect_limit", "文件链接跳转次数过多。", 422);
      currentUrl = parseRemoteDocumentUrl(new URL(location, currentUrl).href);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw remoteImportError("remote_http_error", `文件链接返回 HTTP ${status || "错误"}。`, 422);
    }

    const contentLength = Number(response.headers["content-length"] || 0);
    if (contentLength > maxBytes) {
      response.destroy();
      throw remoteImportError("file_too_large", `远程文件不能超过 ${formatMegabytes(maxBytes)} MB。`, 413);
    }
    const contentEncoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      response.destroy();
      throw remoteImportError("remote_encoding_unsupported", "文件服务器返回了压缩传输内容，请使用直接下载链接。", 422);
    }

    const mime = String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    const fileName = remoteFileName(currentUrl, response.headers["content-disposition"], mime);
    const size = await writeLimitedResponse(response, destination, maxBytes, timeoutMs);
    return {
      requestedUrl: requestedUrl.href,
      finalUrl: currentUrl.href,
      fileName,
      mime,
      size,
      etag: String(response.headers.etag || ""),
      lastModified: parseHttpDate(response.headers["last-modified"])
    };
  }

  throw remoteImportError("remote_redirect_limit", "文件链接跳转次数过多。", 422);
}

export function parseRemoteDocumentUrl(input) {
  const value = String(input || "").trim();
  if (!value || value.length > 4096) throw remoteImportError("invalid_remote_url", "请输入有效的文件链接。", 400);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw remoteImportError("invalid_remote_url", "请输入完整的 HTTP 或 HTTPS 文件链接。", 400);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw remoteImportError("invalid_remote_url", "仅支持不含账号密码的 HTTP 或 HTTPS 文件链接。", 400);
  }
  return url;
}

export function isRemoteAddressForbidden(address) {
  const value = String(address || "").trim().toLowerCase().split("%", 1)[0];
  const version = net.isIP(value);
  if (version === 4) {
    const parts = value.split(".").map(Number);
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const embeddedIpv4 = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
    if (embeddedIpv4 && isRemoteAddressForbidden(embeddedIpv4)) return true;
    return value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:") ||
      value.startsWith("2001:0000:") || value.startsWith("2001:0:") || value.startsWith("2002:") ||
      value.startsWith("64:ff9b:");
  }
  return true;
}

async function openRemoteResponse(url, { timeoutMs, allowPrivate }) {
  const address = await resolveRemoteAddress(url.hostname, allowPrivate);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "GET",
      agent: false,
      headers: {
        Accept: "application/pdf,image/*,text/*,application/octet-stream,application/msword,application/vnd.ms-office,*/*;q=0.5",
        "Accept-Encoding": "identity",
        "User-Agent": "ReviewAnnotation/0.6"
      },
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }
    }, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(remoteImportError("remote_timeout", "下载文件超时，请稍后重试。", 504)));
    request.once("error", (error) => reject(normalizeNetworkError(error)));
    request.end();
  });
}

async function resolveRemoteAddress(hostname, allowPrivate) {
  const normalizedHost = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  const literalAddress = net.isIP(normalizedHost) !== 0;
  if (["localhost", "localhost.localdomain"].includes(normalizedHost) || normalizedHost.endsWith(".localhost")) {
    if (!allowPrivate) throw remoteImportError("remote_address_forbidden", "不能从本机或局域网地址导入文件。", 403);
  }
  let records;
  if (literalAddress) {
    records = [{ address: normalizedHost, family: net.isIP(normalizedHost) }];
  } else {
    try {
      records = await dns.lookup(normalizedHost, { all: true, verbatim: true });
    } catch {
      throw remoteImportError("remote_host_unavailable", "无法解析文件链接中的服务器地址。", 422);
    }
  }
  if (!records.length) throw remoteImportError("remote_host_unavailable", "无法解析文件链接中的服务器地址。", 422);
  // macOS network filters may resolve public hosts through the RFC 2544 benchmark range.
  const proxySyntheticResolution = !literalAddress && records.every((record) => isSyntheticProxyAddress(record.address));
  if (!allowPrivate && !proxySyntheticResolution && records.some((record) => isRemoteAddressForbidden(record.address))) {
    throw remoteImportError("remote_address_forbidden", "不能从本机、局域网或保留地址导入文件。", 403);
  }
  return records[0];
}

function isSyntheticProxyAddress(address) {
  const parts = String(address || "").split(".").map(Number);
  return parts.length === 4 && parts[0] === 198 && [18, 19].includes(parts[1]);
}

async function writeLimitedResponse(response, destination, maxBytes, timeoutMs) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(remoteImportError("file_too_large", `远程文件不能超过 ${formatMegabytes(maxBytes)} MB。`, 413));
        return;
      }
      callback(null, chunk);
    }
  });
  const timeout = setTimeout(() => response.destroy(remoteImportError("remote_timeout", "下载文件超时，请稍后重试。", 504)), timeoutMs);
  try {
    await pipeline(response, limiter, fs.createWriteStream(destination, { flags: "wx" }));
    return size;
  } catch (error) {
    throw normalizeNetworkError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function remoteFileName(url, contentDisposition, mime) {
  const dispositionName = contentDispositionFileName(contentDisposition);
  let candidate = dispositionName || safeDecodeURIComponent(path.posix.basename(url.pathname)) || "远程文档";
  candidate = path.basename(candidate.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "远程文档";
  const mimeExtension = extensionForMime(mime);
  const currentExtension = path.extname(candidate).slice(1).toLowerCase();
  if (mimeExtension && !currentExtension) candidate = `${candidate}.${mimeExtension}`;
  if (mimeExtension && currentExtension && !supportedExtension(currentExtension)) candidate = `${path.basename(candidate, path.extname(candidate))}.${mimeExtension}`;
  return candidate;
}

function contentDispositionFileName(value) {
  const text = String(value || "");
  const encoded = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) return safeDecodeURIComponent(encoded.replace(/^"|"$/g, ""));
  return text.match(/filename\s*=\s*"([^"]+)"/i)?.[1] || text.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() || "";
}

function extensionForMime(mime) {
  const exact = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
    "text/html": "html",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"
  };
  return exact[mime] || "";
}

function supportedExtension(extension) {
  return ["pdf", "png", "jpg", "jpeg", "webp", "gif", "md", "markdown", "txt", "csv", "tsv", "html", "htm", "ppt", "pptx", "doc", "docx", "xls", "xlsx"].includes(extension);
}

function normalizeNetworkError(error) {
  if (error?.code && String(error.code).startsWith("remote_")) return error;
  if (error?.code === "file_too_large") return error;
  return remoteImportError("remote_download_failed", `无法下载文件：${error?.message || "网络连接失败"}`, 422);
}

function remoteImportError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function parseHttpDate(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatMegabytes(bytes) {
  return Math.max(1, Math.round(Number(bytes || 0) / (1024 * 1024)));
}
