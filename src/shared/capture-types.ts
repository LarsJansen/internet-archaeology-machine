export interface Capture {
  timestamp: string;
  originalUrl: string;
  statusCode: string;
  mimeType: string;
  digest: string;
  length: number | null;
  replayUrl: string;
}

export interface CapturesResponse {
  domain: string;
  captures: Capture[];
  source: "internet-archive-cdx";
  limitation: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

// A bounded one-per-year sample from the CDX index, not a guarantee of
// exhaustive archive coverage or proof a site was offline in other years.
export interface YearsResponse {
  domain: string;
  years: number[];
  source: "internet-archive-cdx";
  truncated: boolean;
  limitation: string;
}
