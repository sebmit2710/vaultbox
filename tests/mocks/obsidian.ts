export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }

  hide(): void {}
  setMessage(_message: string): void {}
}

type RequestUrl = (request: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}) => Promise<{
  status: number;
  text: string;
  arrayBuffer?: ArrayBuffer;
  json: unknown;
  headers: Record<string, string>;
}>;

let requestUrlMock: RequestUrl | null = null;

export function setRequestUrlMock(mock: RequestUrl | null): void {
  requestUrlMock = mock;
}

export async function requestUrl(request: Parameters<RequestUrl>[0]): Promise<Awaited<ReturnType<RequestUrl>>> {
  if (!requestUrlMock) {
    throw new Error("requestUrl is not available in tests.");
  }

  return requestUrlMock(request);
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class App {}

export function addIcon(): void {}

// Minimal UI exports needed to import the real Vaultbox Plugin class in headless tests.
export class Modal {}
export function setIcon(): void {}
