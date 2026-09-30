/**
 * TaruBot's own Lodestone parser (2.20.0), which replaced Nodestone: the rules it applies to
 * lodestone-css-selectors definitions. Real-page parity with the Nodestone build was checked
 * separately on live pages (docs/archive/README.md); these pin each rule with synthetic HTML.
 */
import { describe, expect, test } from "bun:test";
import {
  columnName,
  parsePage,
  translateRegex,
} from "../../src/infrastructure/lodestone/parser.js";
import {
  PARSED_KEYS,
  pagePlan,
  pageUrl,
  SELECTOR_FILES,
} from "../../src/infrastructure/lodestone/pages.js";

const SERVER = {
  selector: ".world",
  regex: "(?P<World>\\w*)\\s+\\[(?P<DC>\\w*)\\]",
};

describe("names, regexes and URLs", () => {
  test("selector keys become the field names the bot reads", () => {
    expect(
      ["NAME", "FREE_COMPANY", "ID", "ACTIVE_MEMBER_COUNT", "FC_RANK_ICON", "PAGE_INFO"].map(
        columnName,
      ),
    ).toEqual(["Name", "FreeCompany", "ID", "ActiveMemberCount", "FcRankIcon", "PageInfo"]);
  });

  test("Python-style named groups and backreferences translate to JavaScript", () => {
    expect(
      translateRegex("(?P<World>\\w*)\\s+\\[(?P<DC>\\w*)\\]").exec("Diabolos [Crystal]")?.groups,
    ).toEqual({
      World: "Diabolos",
      DC: "Crystal",
    });
    expect(translateRegex("(?P<A>x)(?P=A)").test("xx")).toBe(true);
  });

  test("each operation reads its page, with query values encoded once", () => {
    expect(pageUrl({ operation: "profile", id: "38371223", biography: false }, "na")).toBe(
      "https://na.finalfantasyxiv.com/lodestone/character/38371223",
    );
    expect(pageUrl({ operation: "fc", id: "9232097761132958152" }, "eu")).toBe(
      "https://eu.finalfantasyxiv.com/lodestone/freecompany/9232097761132958152",
    );
    expect(pageUrl({ operation: "members", id: "9232097761132958152", page: 2 }, "na")).toBe(
      "https://na.finalfantasyxiv.com/lodestone/freecompany/9232097761132958152/member?page=2",
    );
    expect(
      pageUrl({ operation: "search", name: "Al'ice O Neil&x", world: "Diabolos", page: 1 }, "na"),
    ).toBe(
      "https://na.finalfantasyxiv.com/lodestone/character/?q=Al%27ice+O+Neil%26x&worldname=Diabolos&page=1",
    );
  });

  test("every file an operation reads is in the bundled and live selector set", () => {
    const operations = [
      { operation: "profile", id: "1", biography: true },
      { operation: "fc", id: "1" },
      { operation: "members", id: "1", page: 1 },
      { operation: "search", name: "a", world: "b", page: 1 },
    ] as const;
    for (const input of operations) {
      for (const file of pagePlan(input).files) expect(SELECTOR_FILES).toContain(file as never);
      // New selector sets must keep every key an operation parses (selectors.ts).
      for (const key of pagePlan(input).keys) expect(PARSED_KEYS).toContain(key);
    }
    // The biography is read only when asked for (proof verification).
    expect(pagePlan({ operation: "profile", id: "1", biography: false }).keys).not.toContain("BIO");
  });
});

describe("parsing rules", () => {
  const profile = { operation: "profile", id: "1", biography: false } as const;

  test("values are raw innerHTML or attributes; regex groups spread into the record", () => {
    const files = [
      {
        NAME: { selector: ".name" },
        SERVER,
        FREE_COMPANY: {
          ID: { selector: ".fc a", attribute: "href", regex: "/freecompany/(?P<ID>\\d+)/" },
          NAME: { selector: ".fc a" },
          CREST: { selector: ".crest", attribute: "src" },
        },
      },
    ];
    const html =
      '<p class="name">Al&#39;ice <b>O</b></p><p class="world"><i></i>Diabolos [Crystal]</p><div class="fc"><a href="/lodestone/freecompany/9232097761132958152/">Woven Souls</a></div>';
    expect(parsePage(profile, html, files)).toEqual({
      // innerHTML, markup and entities intact: the bot's adapter decodes it.
      Name: "Al'ice <b>O</b>",
      World: "Diabolos",
      DC: "Crystal",
      // Large IDs stay strings; a missing element is left out of a group.
      FreeCompany: { ID: "9232097761132958152", Name: "Woven Souls" },
    });
  });

  test("missing elements are null, an empty group is null, and a missing attribute is empty", () => {
    const files = [
      {
        NAME: { selector: ".missing" },
        SERVER,
        FREE_COMPANY: { ID: { selector: ".nothing", attribute: "href" } },
        BIO: { selector: ".bio", attribute: "data-none" },
      },
    ];
    expect(parsePage({ ...profile, biography: true }, '<p class="bio">text</p>', files)).toEqual({
      Name: null,
      // A regex column with no element keeps its own null field (as Nodestone did); the bot's
      // adapter then rejects the profile, because World and DC are required.
      Server: null,
      FreeCompany: null,
      Bio: "",
    });
  });

  test("paginated pages: the root narrows the page, entries list with malformed rows kept, and pagination", () => {
    const files = [
      {
        ROOT: { selector: ".window" },
        ENTRY: {
          ROOT: { selector: "li.entry", multiple: true },
          ID: { selector: "a", attribute: "href", regex: "/character/(?P<ID>\\d+)/" },
          NAME: { selector: ".entry__name" },
        },
        PAGE_INFO: { selector: ".pager", regex: "\\D*(?P<CurrentPage>\\d+)\\D*(?P<NumPages>\\d+)" },
      },
    ];
    const page = (current: number, total: number) =>
      `<li class="entry">outside the root</li><div class="window"><ul><li class="entry"><a href="/lodestone/character/123/"></a><p class="entry__name">A</p></li><li class="entry"></li></ul><p class="pager">Page ${current} of ${total}</p></div>`;
    const members = { operation: "members", id: "1", page: 1 } as const;
    expect(parsePage(members, page(1, 3), files)).toEqual({
      List: [{ ID: "123", Name: "A" }, null],
      Pagination: { Page: 1, PageTotal: 3, PageNext: 2, PagePrev: null },
    });
    expect((parsePage(members, page(3, 3), files) as { Pagination: unknown }).Pagination).toEqual({
      Page: 3,
      PageTotal: 3,
      PageNext: null,
      PagePrev: 2,
    });
    // A page without the root (an error or maintenance page) is invalid, never an empty roster.
    expect(() => parsePage(members, "<p>Maintenance</p>", files)).toThrow("Missing page root");
  });
});
