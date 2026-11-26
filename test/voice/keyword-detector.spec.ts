import { KeywordDetector } from "../../src/voice/keywordDetection.js";

describe("KeywordDetector", () => {
  let detector: KeywordDetector;

  beforeEach(() => {
    detector = new KeywordDetector("jarvis");
  });

  describe("Default wake word (Nimbus)", () => {
    const nimbus = new KeywordDetector();

    it("wakes on the name and on likely speech-to-text misspellings", () => {
      for (const heard of ["Nimbus, play some lo-fi", "hey nimbus what did Sam say?", "nimbis", "nimbo", "limbus"]) {
        expect(nimbus.containsKeyword(heard)).toBe(true);
      }
    });

    it("wakes when speech-to-text splits the name into words", () => {
      expect(nimbus.containsKeyword("Nim bus, skip this song")).toBe(true);
    });

    it("stays asleep for everyday speech", () => {
      for (const heard of ["we missed the bus", "what's the number?", "minus ten degrees", "that's a bonus", "check the status"]) {
        expect(nimbus.containsKeyword(heard)).toBe(false);
      }
    });
  });

  describe("Exact and Substring Matches", () => {
    it("should return true for an exact keyword match (case-insensitive)", () => {
      expect(detector.containsKeyword("Jarvis")).toBe(true);
      expect(detector.containsKeyword("jarvis")).toBe(true);
    });

    it("should return true when the keyword is embedded in a larger string", () => {
      expect(detector.containsKeyword("Hey jarvis what is nine plus nine?")).toBe(true);
      expect(detector.containsKeyword("The amazing Jarvis project")).toBe(true);
    });
  });

  describe("Approximate Matches (within allowed edit distance)", () => {
    it("should return true for words with an edit distance equal to the threshold", () => {
      // "jarv" is missing two letters from "jarvis" (distance = 2)
      expect(detector.containsKeyword("jarv")).toBe(true);
    });

    it("should return true for words with an edit distance less than the threshold", () => {
      // "jarvix" has one substitution (s -> x) (distance = 1)
      expect(detector.containsKeyword("jarvix")).toBe(true);
    });
  });

  describe("Non-Matches", () => {
    it("should return false for words with an edit distance exceeding the threshold", () => {
      // "jav" differs too much from "jarvis"
      expect(detector.containsKeyword("jav")).toBe(false);
    });

    it("should return false for completely unrelated words", () => {
      expect(detector.containsKeyword("assistant")).toBe(false);
    });

    it("should return false for empty input", () => {
      expect(detector.containsKeyword("")).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle extra whitespace", () => {
      expect(detector.containsKeyword("   jarvis   ")).toBe(true);
    });

    it("should handle punctuation", () => {
      expect(detector.containsKeyword("jarvis!")).toBe(true);
      expect(detector.containsKeyword("!jarvis?")).toBe(true);
    });

    it("should handle mixed content strings", () => {
      const input = "Hello, I think Jarvis is an amazing AI, despite a few typos like jarvix or jarv.";
      // The sentence contains an exact match ("Jarvis") and near matches.
      expect(detector.containsKeyword(input)).toBe(true);
    });
  });
});
