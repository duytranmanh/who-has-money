import Groq from "groq-sdk";
import { readFile } from "node:fs/promises";


// We are currently using objects for structure and reusability
// We trade away some flexibility and more set up
type Company = {
    slug: string;
    name: string;
    [key: string]: unknown;
};

type Profile = {
    target: string[];
    experience: string[];
    hard_nos: string[];
    preferences: string[];
};

async function main() {
    const slug = process.argv[2];

    if (!slug) {
        throw new Error(
            "Usage: node scripts/research-company.ts <company-slug>",
        );
    }

    const contents = await readFile("fixtures/companies.json", "utf8");
    const data: { companies: Company[] } = JSON.parse(contents);
    const company = data.companies.find(company => company.slug === slug);

    if (!company) {
        throw new Error(`Company not found: ${slug}`);
    }

    // Profile should contain;
    // - What i'm looking for (target)
    // - my experience (experience)
    // - Hard nos (hard requirements)
    // - preferences
    // Pull this from data/profile
    const profileContents = await readFile("data/profile.json", "utf8");
    const profile: Profile = JSON.parse(profileContents);

    // This should include:
    // - profile
    // - company
    // - What the agent should do
    const input = {
        profile,
        company,
        task: "Assess whether this company is worth investigating for software engineering work, using the supplied profile.",
        instructions: [
            "Screen against hard_nos and explain any confirmed exclusion.",
            "Connect fit reasons to specific interests and experience in the profile.",
            "Separate company fit from evidence of hiring or suitability for a particular role.",
            "Support factual claims with supplied company fields or sources actually read; do not invent facts or URLs.",
            "Keep missing or unverified information unknown rather than treating it as a confirmed mismatch.",
            "Suggest applying, cold outreach, further research, or skipping only when the evidence supports that next step.",
        ],
        output_fields: [
            "company_slug",
            "fit_judgment: strong_fit, possible_fit, insufficient_evidence, or reject",
            "reasons_connected_to_profile",
            "supporting_facts with source URLs or company field references",
            "mismatches",
            "unknowns",
            "recommended_next_step with action and reason",
        ],
    };

    const client = new Groq();

    const response = await client.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
            {
                role: "system",
                content:
                    "Assess company fit using the supplied information. " +
                    "Treat missing information as unknown. " +
                    "Do not claim to have searched or read websites.",
            },
            {
                role: "user",
                content: JSON.stringify(input),
            },
        ],
        max_completion_tokens: 4096,
    })

    const assessment = response.choices[0]?.message.content;

    if (!assessment) {
        throw new Error("Groq returned no assessment")
    }

    console.log(assessment);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
