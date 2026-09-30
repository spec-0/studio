import { describe, expect, it } from "vitest";
import {
  closeTab,
  dropTabs,
  EMPTY_TABS,
  neighbourTab,
  openTab,
  parseTabs,
  TAB_LIMIT,
  type TabsState,
  type TabTarget,
} from "../tabs";

const target = (apiId: string, operationId: string, apiTitle = apiId): TabTarget => {
  const [method, path] = operationId.split(" ");
  return { apiId, operationId, method, path, apiTitle };
};

const never = () => false;
const open = (state: TabsState, ...targets: TabTarget[]) =>
  targets.reduce((now, next) => openTab(now, next, never), state);

const orders = target("file_orders", "GET /orders", "Orders");
const order = target("file_orders", "GET /orders/{orderId}", "Orders");
const payment = target("url_pay", "POST /payments", "Payments");

describe("openTab", () => {
  it("opens a tab at the end and makes it active", () => {
    const state = open(EMPTY_TABS, orders, payment);
    expect(state.tabs.map((tab) => tab.key)).toEqual(["file_orders GET /orders", "url_pay POST /payments"]);
    expect(state.activeKey).toBe("url_pay POST /payments");
  });

  it("focuses a tab that is already open instead of opening another", () => {
    const state = open(EMPTY_TABS, orders, payment, orders);
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBe("file_orders GET /orders");
    // In place: tabs don't move when focused.
    expect(state.tabs[0].key).toBe("file_orders GET /orders");
  });

  it("keeps the same state when the active tab is opened again", () => {
    const state = open(EMPTY_TABS, orders);
    expect(openTab(state, orders, never)).toBe(state);
  });

  it("follows a renamed API", () => {
    const state = openTab(open(EMPTY_TABS, orders), { ...orders, apiTitle: "Orders v2" }, never);
    expect(state.tabs[0].apiTitle).toBe("Orders v2");
  });

  it(`closes the tab used longest ago past ${TAB_LIMIT}`, () => {
    let state = EMPTY_TABS;
    for (let index = 0; index < TAB_LIMIT; index += 1) state = open(state, target("a", `GET /r${index}`));
    // Use the first one again, so the second is now the oldest.
    state = open(state, target("a", "GET /r0"));
    state = open(state, target("a", "GET /new"));
    expect(state.tabs).toHaveLength(TAB_LIMIT);
    expect(state.tabs.some((tab) => tab.key === "a GET /r1")).toBe(false);
    expect(state.tabs.some((tab) => tab.key === "a GET /r0")).toBe(true);
    expect(state.activeKey).toBe("a GET /new");
  });

  it("never closes a tab with unsent changes to make room", () => {
    let state = EMPTY_TABS;
    for (let index = 0; index < 3; index += 1) state = open(state, target("a", `GET /r${index}`));
    const unsent = (key: string) => key === "a GET /r0";
    state = openTab(state, target("a", "GET /new"), unsent, 3);
    expect(state.tabs.map((tab) => tab.key)).toEqual(["a GET /r0", "a GET /r2", "a GET /new"]);
  });

  it("goes over the limit rather than close tabs that all have unsent changes", () => {
    let state = EMPTY_TABS;
    for (let index = 0; index < 3; index += 1) state = open(state, target("a", `GET /r${index}`));
    state = openTab(state, target("a", "GET /new"), () => true, 3);
    expect(state.tabs).toHaveLength(4);
  });
});

describe("closeTab", () => {
  const three = open(EMPTY_TABS, orders, order, payment);

  it("activates the tab to the right of the active one it closes", () => {
    const focused = openTab(three, order, never);
    const { state, next } = closeTab(focused, focused.activeKey!);
    expect(next?.key).toBe(payment.apiId + " " + payment.operationId);
    expect(state.activeKey).toBe(next?.key);
    expect(state.tabs).toHaveLength(2);
  });

  it("activates the tab to the left when the last one closes", () => {
    const { next } = closeTab(three, three.activeKey!);
    expect(next?.operationId).toBe("GET /orders/{orderId}");
  });

  it("leaves the active tab alone when another one closes", () => {
    const { state, next } = closeTab(three, "file_orders GET /orders");
    expect(next).toBeNull();
    expect(state.activeKey).toBe(three.activeKey);
  });

  it("has nothing to activate after the only tab closes", () => {
    const one = open(EMPTY_TABS, orders);
    const { state, next } = closeTab(one, one.activeKey!);
    expect(next).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.activeKey).toBeNull();
  });

  it("ignores a tab that isn't open", () => {
    expect(closeTab(three, "nope").state).toBe(three);
  });
});

describe("neighbourTab", () => {
  const three = open(EMPTY_TABS, orders, order, payment);

  it("moves along the strip and wraps at both ends", () => {
    expect(neighbourTab(three, 1)?.key).toBe("file_orders GET /orders");
    expect(neighbourTab(three, -1)?.key).toBe("file_orders GET /orders/{orderId}");
    const first = openTab(three, orders, never);
    expect(neighbourTab(first, -1)?.key).toBe("url_pay POST /payments");
  });

  it("has nowhere to go with one tab or none", () => {
    expect(neighbourTab(open(EMPTY_TABS, orders), 1)).toBeNull();
    expect(neighbourTab(EMPTY_TABS, 1)).toBeNull();
  });
});

describe("dropTabs", () => {
  it("drops tabs whose API or operation is gone, and the active key with them", () => {
    const three = open(EMPTY_TABS, orders, order, payment);
    const state = dropTabs(three, (tab) => tab.apiId === "url_pay");
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBeNull();
    expect(dropTabs(state, () => false)).toBe(state);
  });
});

describe("parseTabs", () => {
  it("reads back what it wrote, across a restart", () => {
    const state = open(EMPTY_TABS, orders, payment, orders);
    expect(parseTabs(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("ignores anything that doesn't look like tabs, rather than failing", () => {
    expect(parseTabs(null)).toEqual(EMPTY_TABS);
    expect(parseTabs({ version: 9, tabs: [] })).toEqual(EMPTY_TABS);
    const read = parseTabs({
      version: 1,
      tabs: [{ apiId: "a", operationId: "GET /x" }, { apiId: "a", operationId: "GET /x" }, { nope: true }],
      activeKey: "missing",
    });
    expect(read.tabs.map((tab) => tab.key)).toEqual(["a GET /x"]);
    expect(read.activeKey).toBeNull();
  });
});
