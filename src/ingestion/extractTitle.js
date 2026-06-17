import { ai } from "../config/gemini.js";
export async function extractTitle(text) {
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
Extract ONLY the book title.

Return JSON:
{ "title": "..." }

TEXT:"Contagious WHY THINGS CATCH ON JONAH BERGER “Jonah Berger knows more about what makes information ‘go viral’ than anyone in the world.” —=DANIEL GILBERT, Harvard College Professor of Psychology and author of Stumbling on Happiness Contagious WHY THINGS CATCH ON JONAH BERGER “Jonah Berger knows more about what makes information ‘go viral’ than anyone in the world.” —=DANIEL GILBERT, Harvard College Professor of Psychology and author ofStumbling on Happiness [Link] http://eBookNews.SimonandSchuster.com/front/9781451686593 [Link] http://eBookNews.SimonandSchuster.com/front/9781451686593 Thank you for downloading this Simon & Schuster eBook. Join our mailing list and get updates on new releases, deals, bonus content and other great books from Simon & Schuster. CLICK HERE TO SIGN UP or visit us online to sign up at eBookNews.SimonandSchuster.com CONTAGIOUS Why Things Catch On JONAH BERGER SIMON & SCHUSTER New York London Toronto Sydney New Delhi Contents Introduction: Why Things Catch On Why $100 is a good price for a cheesesteak . . . Why do some things become popular? . . . Which is more important, the message or the messenger? . . . Can you make anything contagious? . . . The case of", 
`,
  });

  const raw = res.text;
  try {
    // Strip markdown code blocks and parse
    const cleanedRaw = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleanedRaw);
    return parsed.title || "Unknown Book";
  } catch (err) {
    console.error("Title extraction failed:", err.message);
    return "Unknown Book";
  }
}