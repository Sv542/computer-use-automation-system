import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import type {
  BrowserAction,
  Condition,
  FrameObservation,
  JsonValue,
  LocatorDefinition,
  ParameterType,
  SurfaceObservation,
  TargetApplication,
  TargetDefinition,
} from "../domain/types.js";
import { redactObservationText } from "../infra/redaction.js";

export class TargetResolutionError extends Error {
  readonly attempts: string[];

  constructor(message: string, attempts: string[]) {
    super(message);
    this.name = "TargetResolutionError";
    this.attempts = attempts;
  }
}

interface ResolvedTarget {
  locator: Locator;
  frame: Frame;
  strategy: LocatorDefinition;
  attempts: string[];
}

interface OperatorAction {
  kind: "click" | "input" | "change";
  element: string;
  at: string;
  value: "[REDACTED]" | null;
}

function locatorDescription(locator: LocatorDefinition): string {
  return JSON.stringify(locator);
}

function asLocator(frame: Frame, definition: LocatorDefinition): Locator {
  switch (definition.strategy) {
    case "role":
      return frame.getByRole(definition.role as never, {
        name: definition.name,
        exact: definition.exact ?? true,
      });
    case "label":
      return frame.getByLabel(definition.label, { exact: definition.exact ?? true });
    case "text":
      return frame.getByText(definition.text, { exact: definition.exact ?? true });
    case "css":
      return frame.locator(definition.selector);
  }
}

function parseExtracted(raw: string, type: ParameterType): JsonValue {
  const trimmed = raw.trim();
  switch (type) {
    case "money": {
      const amount = Number(trimmed.replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(amount)) throw new Error(`Could not parse money value: ${trimmed}`);
      return { currency: trimmed.includes("$") ? "USD" : "UNKNOWN", amountMinor: Math.round(amount * 100) };
    }
    case "integer": {
      const value = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(value)) throw new Error(`Could not parse integer value: ${trimmed}`);
      return value;
    }
    case "number": {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) throw new Error(`Could not parse numeric value: ${trimmed}`);
      return value;
    }
    case "boolean":
      return /^(true|yes|1)$/i.test(trimmed);
    case "string":
      return trimmed;
  }
}

export class WebSurface {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly target: TargetApplication;

  private constructor(browser: Browser, context: BrowserContext, page: Page, target: TargetApplication) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.target = target;
  }

  static async launch(
    target: TargetApplication,
    options: { headless?: boolean; channel?: string } = {},
  ): Promise<WebSurface> {
    const browser = await chromium.launch({
      headless: options.headless ?? true,
      channel: options.channel ?? process.env.CHROME_CHANNEL ?? "chrome",
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    return new WebSurface(browser, context, page, target);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  currentUrl(): string {
    return this.page.url() || this.target.entrypoint;
  }

  async policyUrlFor(action: BrowserAction): Promise<string> {
    if (action.kind === "navigate") return this.currentUrl();
    if (action.target.frame) return this.findFrame(action.target.frame).url();
    return (await this.resolve(action.target)).frame.url();
  }

  async gotoEntrypoint(): Promise<void> {
    await this.page.goto(this.target.entrypoint, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle");
  }

  private findFrame(target?: TargetDefinition["frame"]): Frame {
    if (!target) return this.page.mainFrame();
    const frame = this.page.frames().find((candidate) => {
      const nameMatches = !target.name || candidate.name() === target.name;
      const urlMatches = !target.urlPattern || new RegExp(target.urlPattern).test(candidate.url());
      return nameMatches && urlMatches;
    });
    if (!frame) throw new TargetResolutionError(`Frame not found: ${JSON.stringify(target)}`, []);
    return frame;
  }

  async resolve(target: TargetDefinition, timeoutMs = 2_000): Promise<ResolvedTarget> {
    const frames = target.frame ? [this.findFrame(target.frame)] : this.page.frames();
    const attempts: string[] = [];
    const definitions = [target.primary, ...(target.fallbacks ?? [])];

    for (const definition of definitions) {
      const visible: Array<{ locator: Locator; frame: Frame }> = [];
      for (const frame of frames) {
        const candidate = asLocator(frame, definition);
        attempts.push(`${frame.name() || "top"}:${locatorDescription(definition)}`);
        try {
          await candidate.first().waitFor({ state: "attached", timeout: Math.min(timeoutMs, 400) });
          const count = await candidate.count();
          for (let index = 0; index < count; index += 1) {
            const item = candidate.nth(index);
            if (await item.isVisible()) visible.push({ locator: item, frame });
          }
        } catch {
          // Continue across frames and through the ordered fallback bundle.
        }
      }
      if (visible.length === 1) {
        return { locator: visible[0]!.locator, frame: visible[0]!.frame, strategy: definition, attempts };
      }
      if (visible.length > 1) attempts.push(`ambiguous:${visible.length}`);
    }

    throw new TargetResolutionError("No unique visible control matched the locator bundle.", attempts);
  }

  async enrichTarget(target: TargetDefinition): Promise<TargetDefinition> {
    const resolved = await this.resolve(target);
    const metadata = await resolved.locator.evaluate((element) => {
      const html = element as HTMLElement;
      const input = element as HTMLInputElement;
      const labels = "labels" in input && input.labels ? [...input.labels].map((label) => label.textContent?.trim() ?? "") : [];
      return {
        tag: html.tagName.toLowerCase(),
        id: html.id,
        name: html.getAttribute("name") ?? "",
        type: html.getAttribute("type") ?? "",
        ariaLabel: html.getAttribute("aria-label") ?? "",
        text: (html.innerText || input.value || "").trim().slice(0, 160),
        label: labels.find(Boolean) ?? "",
      };
    });

    const fallbacks: LocatorDefinition[] = [];
    if (metadata.label && target.primary.strategy !== "label") {
      fallbacks.push({ strategy: "label", label: metadata.label, exact: true });
    }
    if (metadata.ariaLabel && target.primary.strategy !== "role") {
      fallbacks.push({ strategy: "role", role: metadata.tag === "button" ? "button" : "generic", name: metadata.ariaLabel });
    }
    if (metadata.text && ["button", "a", "h1", "h2"].includes(metadata.tag) && target.primary.strategy !== "text") {
      fallbacks.push({ strategy: "text", text: metadata.text, exact: true });
    }
    if (metadata.name) {
      const escaped = metadata.name.replaceAll('"', '\\"');
      fallbacks.push({ strategy: "css", selector: `${metadata.tag}[name="${escaped}"]` });
    } else if (metadata.id) {
      const escaped = metadata.id.replaceAll('"', '\\"');
      fallbacks.push({ strategy: "css", selector: `[id="${escaped}"]` });
    }

    return {
      ...target,
      ...(!target.frame && resolved.frame.name() ? { frame: { name: resolved.frame.name() } } : {}),
      fallbacks,
      fingerprint: { tag: metadata.tag, ...(metadata.type ? { controlType: metadata.type } : {}) },
      rationale:
        "Prefer a semantic role/name or label; retain structural attributes only as ordered fallbacks. Replay requires a unique visible match.",
    };
  }

  async execute(action: BrowserAction, inputs: Record<string, JsonValue>, timeoutMs = 5_000): Promise<JsonValue | undefined> {
    if (action.kind === "navigate") {
      await this.page.goto(new URL(action.path, this.currentUrl()).toString(), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      return;
    }

    const { locator } = await this.resolve(action.target, timeoutMs);
    if (action.kind === "click") {
      await locator.click({ timeout: timeoutMs });
      // Frame navigations do not advance the top page's load state. Give the
      // frame a short settle window before the next observation/checkpoint.
      await this.page.waitForTimeout(150);
      return;
    }
    if (action.kind === "type") {
      const raw = action.value.kind === "parameter" ? inputs[action.value.name] : action.value.value;
      if (raw === undefined || raw === null) throw new Error(`Input ${action.value.kind === "parameter" ? action.value.name : "value"} is missing.`);
      if (action.clear) await locator.fill(String(raw), { timeout: timeoutMs });
      else await locator.pressSequentially(String(raw), { timeout: timeoutMs });
      return;
    }

    return parseExtracted(await locator.innerText({ timeout: timeoutMs }), action.parseAs);
  }

  async conditionMet(condition: Condition): Promise<boolean> {
    if (condition.kind === "url_matches") return new RegExp(condition.pattern).test(this.currentUrl());
    try {
      const { locator } = await this.resolve(condition.target, 750);
      if (condition.kind === "visible") return locator.isVisible();
      if (condition.kind === "not_visible") return !(await locator.isVisible());
      if (condition.kind === "text_matches") {
        return new RegExp(condition.pattern, "i").test(await locator.innerText({ timeout: 750 }));
      }
      return false;
    } catch {
      return condition.kind === "not_visible";
    }
  }

  async observe(): Promise<SurfaceObservation> {
    const frames: FrameObservation[] = [];
    for (const frame of this.page.frames()) {
      const observation = await frame.evaluate((redactSelectors) => {
        const elements = [...document.querySelectorAll<HTMLElement>("button,input,select,textarea,a,[role],[aria-label]")];
        const controls = elements.slice(0, 80).map((element) => {
          const input = element as HTMLInputElement;
          const tag = element.tagName.toLowerCase();
          const sensitive = redactSelectors.some((selector) => {
            try { return element.matches(selector); } catch { return false; }
          });
          const explicitRole = element.getAttribute("role");
          const role = explicitRole ??
            (tag === "a" ? "link" : tag === "button" || input.type === "submit" ? "button" :
              tag === "input" && ["checkbox", "radio"].includes(input.type) ? input.type :
              ["input", "textarea"].includes(tag) ? "textbox" : tag === "select" ? "combobox" : "generic");
          const label = "labels" in input && input.labels ? [...input.labels].map((item) => item.textContent?.trim()).find(Boolean) : undefined;
          const name = element.getAttribute("aria-label") || label ||
            (!sensitive && tag === "input" && ["button", "submit"].includes(input.type) ? input.value : "") ||
            (!sensitive ? element.innerText?.trim() : "") || element.getAttribute("title") || element.getAttribute("placeholder") || "[REDACTED]";
          return {
            tag,
            role,
            name: name.slice(0, 160),
            ...(label ? { label } : {}),
            ...(element.getAttribute("placeholder") ? { placeholder: element.getAttribute("placeholder")! } : {}),
            ...(element.getAttribute("type") ? { type: element.getAttribute("type")! } : {}),
            disabled: "disabled" in input ? input.disabled : false,
          };
        });
        const body = document.body?.cloneNode(true) as HTMLElement | undefined;
        if (body) {
          for (const selector of redactSelectors) {
            try {
              body.querySelectorAll<HTMLElement>(selector).forEach((element) => {
                element.textContent = "[REDACTED]";
                if ("value" in element) (element as HTMLInputElement).value = "";
              });
            } catch {
              // Invalid redaction selectors are ignored here and remain visible
              // to the secondary pattern redactor and screenshot masking layer.
            }
          }
        }
        return {
          title: document.title,
          text: body?.innerText.slice(0, 4_000) ?? "",
          controls,
        };
      }, this.target.redactSelectors);
      frames.push({
        name: frame.name() || "top",
        url: frame.url(),
        title: observation.title,
        text: redactObservationText(observation.text),
        controls: observation.controls,
      });
    }
    return { url: this.currentUrl(), title: await this.page.title(), frames };
  }

  async screenshot(path: string): Promise<void> {
    const masks: Locator[] = [];
    for (const frame of this.page.frames()) {
      for (const selector of [...this.target.redactSelectors, "input[type=password]"]) {
        const candidate = frame.locator(selector);
        if ((await candidate.count()) > 0) masks.push(candidate);
      }
    }
    await this.page.screenshot({ path, fullPage: true, mask: masks, maskColor: "#111111" });
  }

  async installOperatorRecorder(): Promise<void> {
    for (const frame of this.page.frames()) {
      await frame.evaluate(() => {
        const state = window as typeof window & { __operatorActions?: OperatorAction[] };
        state.__operatorActions = [];
        for (const kind of ["click", "input", "change"] as const) {
          document.addEventListener(kind, (event) => {
            const html = event.target as HTMLElement | null;
            const element = html
              ? [html.tagName.toLowerCase(), html.getAttribute("role"), html.getAttribute("aria-label"), html.innerText?.trim().slice(0, 60)]
                .filter(Boolean)
                .join(":")
              : "unknown";
            state.__operatorActions?.push({
              kind,
              element,
              at: new Date().toISOString(),
              value: kind === "input" ? "[REDACTED]" : null,
            });
          }, true);
        }
      });
    }
  }

  async collectOperatorActions(): Promise<OperatorAction[]> {
    const actions: OperatorAction[] = [];
    for (const frame of this.page.frames()) {
      actions.push(...(await frame.evaluate(() => {
        const state = window as typeof window & { __operatorActions?: OperatorAction[] };
        return state.__operatorActions ?? [];
      })));
    }
    return actions;
  }
}
