import type { ApiProviderType } from '../types/index.js';

const IPV4_PATTERN = /^(\d{1,3})(?:\.(\d{1,3})){3}$/;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isNonPublicIpv4(hostname: string): boolean {
  if (!IPV4_PATTERN.test(hostname)) return false;

  const octets = hostname.split('.').map(Number);
  if (octets.some(octet => octet > 255)) return false;

  const [first, second, third, fourth] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0 && fourth !== 9 && fourth !== 10)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 192 && second === 88 && third === 99)
    || (first === 198 && second === 18)
    || (first === 198 && second === 19)
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function parseIpv6Groups(hostname: string): number[] | null {
  let normalized = hostname;
  const embeddedIpv4 = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (embeddedIpv4) {
    const octets = embeddedIpv4.split('.').map(Number);
    if (octets.some(octet => octet > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, -embeddedIpv4.length)}${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map(group => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function getMappedIpv4FromIpv6(hostname: string): string | null {
  const groups = parseIpv6Groups(hostname);
  if (!groups || !groups.slice(0, 5).every(group => group === 0) || groups[5] !== 0xffff) {
    return null;
  }

  const high = groups[6];
  const low = groups[7];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isNonPublicIpv6(groups: number[]): boolean {
  const [first, second, third, fourth, fifth, sixth] = groups;
  const allZero = groups.every(group => group === 0);
  const isIpv4Compatible = groups.slice(0, 6).every(group => group === 0);
  const isMapped = groups.slice(0, 5).every(group => group === 0) && sixth === 0xffff;

  // Unspecified, loopback, and the deprecated IPv4-compatible range are not
  // usable as remote API endpoints. IPv4-mapped addresses are checked by the
  // embedded IPv4 policy below so public mapped addresses remain possible.
  if (allZero || isIpv4Compatible) return true;
  if (isMapped) {
    const mappedIpv4 = getMappedIpv4FromIpv6(
      groups.map(group => group.toString(16)).join(':')
    );
    return mappedIpv4 === null || isNonPublicIpv4(mappedIpv4);
  }

  const isWellKnownNat64 = first === 0x64
    && second === 0xff9b
    && third === 0
    && fourth === 0
    && fifth === 0
    && sixth === 0;
  if (isWellKnownNat64) {
    const mappedIpv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
      .join('.');
    return isNonPublicIpv4(mappedIpv4);
  }

  // ULA, link-local, multicast, and historical site-local ranges.
  if ((first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first & 0xffc0) === 0xfec0) {
    return true;
  }

  // Documentation, discard-only, and NAT64 local-use ranges.
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x3fff && (second & 0xf000) === 0) return true; // Documentation
  if (first === 0x5f00) return true; // SRv6 SID
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return true;
  if (first === 0x64 && second === 0xff9b
    && third === 1) {
    return true;
  }

  // Other special-purpose IPv6 prefixes that are not globally reachable.
  if (first === 0x2001 && second === 0x0000) return true; // Teredo
  if (first === 0x2001 && second === 0x0002 && third === 0) return true; // Benchmarking
  if (first === 0x2001
    && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) return true; // ORCHID
  if (first === 0x2002) return true; // 6to4 (deprecated)

  return false;
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (normalized.includes(':')) {
    const groups = parseIpv6Groups(normalized);
    return groups === null || isNonPublicIpv6(groups);
  }

  if (IPV4_PATTERN.test(normalized)) {
    return isNonPublicIpv4(normalized);
  }

  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || (!normalized.includes('.') && !normalized.includes(':'))
  ) {
    return true;
  }

  return false;
}

/** 返回 API 地址不可用的原因；返回 null 表示允许远程 API 地址。 */
export function getApiEndpointValidationError(baseUrl = ''): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return 'API 地址未配置';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'API 地址无效，请填写完整的 HTTPS 地址';
  }

  if (parsed.username || parsed.password) {
    return 'API 地址不能包含用户名或密码';
  }

  if (parsed.protocol !== 'https:') {
    return '第三方 API 必须使用 HTTPS';
  }

  if (isLocalOrPrivateHostname(parsed.hostname)) {
    return '仅支持远程 HTTPS API，本地模型服务地址不受支持';
  }

  return null;
}

export function assertRemoteApiBaseUrl(baseUrl: string): URL {
  const error = getApiEndpointValidationError(baseUrl);
  if (error) throw new Error(error);

  return new URL(baseUrl.trim());
}

export function isRemoteApiBaseUrl(baseUrl = ''): boolean {
  return getApiEndpointValidationError(baseUrl) === null;
}

/**
 * 将用户填写的 API Base URL 转换为实际请求使用的 Base URL。
 * OpenAI 官方地址只需填写 https://api.openai.com，实际请求自动补全 /v1；
 * 已填写路径的第三方地址保持原样，兼容 /codex/v1 等自定义端点。
 */
export function normalizeApiBaseUrl(
  baseUrl = '',
  providerType?: ApiProviderType
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    const isOpenAi = providerType === 'openai'
      || parsed.hostname.toLowerCase() === 'api.openai.com';

    if (!path && isOpenAi) {
      parsed.pathname = '/v1';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // 地址合法性由 getApiHostPermissionPattern 统一校验；这里保留原值，
    // 让调用方继续返回更具体的地址错误。
  }

  return trimmed;
}
