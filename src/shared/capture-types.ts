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
