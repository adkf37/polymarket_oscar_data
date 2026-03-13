#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const ROOT_DIR = process.cwd();
const DEFAULT_DATA_PATH = "site/data/oscars_2026_dashboard.json";
const DEFAULT_CREDENTIALS_PATH = "credentials/google-oauth-client.json";
const DEFAULT_TOKEN_PATH = "credentials/google-token.json";
const FORMS_BATCH_LIMIT = 50;
const CATEGORY_ALIAS_OVERRIDES = {
    "Best Actor": [
        "Actor in a Leading Role",
        "Leading Actor"
    ],
    "Best Actress": [
        "Actress in a Leading Role",
        "Leading Actress"
    ],
    "Best Supporting Actor": [
        "Actor in a Supporting Role",
        "Supporting Actor"
    ],
    "Best Supporting Actress": [
        "Actress in a Supporting Role",
        "Supporting Actress"
    ],
    "Best Director": [
        "Directing",
        "Director"
    ],
    "Best Adapted Screenplay": [
        "Writing (Adapted Screenplay)",
        "Adapted Screenplay"
    ],
    "Best Original Screenplay": [
        "Writing (Original Screenplay)",
        "Original Screenplay"
    ],
    "Best Original Score": [
        "Music (Original Score)",
        "Original Score"
    ],
    "Best Original Song": [
        "Music (Original Song)",
        "Original Song"
    ]
};
const SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.body.readonly"
];

main().catch((error) => {
    console.error(`Fatal: ${error.message}`);

    if (error.cause?.message && error.cause.message !== error.message) {
        console.error(`Cause: ${error.cause.message}`);
    }

    process.exitCode = 1;
});

async function main() {
    const options = parseArguments(process.argv.slice(2));

    if (options.help) {
        printUsage();
        return;
    }

    if (!options.sourceForm && !options.targetForm) {
        printUsage("Missing required argument: --source-form-url or --target-form-url");
        process.exitCode = 1;
        return;
    }

    const dataPath = resolveFromRoot(options.dataPath);
    const credentialsPath = resolveFromRoot(options.credentialsPath);
    const tokenPath = resolveFromRoot(options.tokenPath);

    const nomineeIndex = await loadNomineeIndex(dataPath);
    const auth = await authorize({ credentialsPath, tokenPath });
    const drive = google.drive({ version: "v3", auth });
    const forms = google.forms({ version: "v1", auth });
    const targetYear = nomineeIndex.year;

    let operation = "updated";
    let summaryTitle = "";
    let sourceFormId = "";
    let targetFormId = "";
    let workingForm = null;
    let infoRequests = [];

    if (options.targetForm) {
        targetFormId = extractFormId(options.targetForm);
        sourceFormId = targetFormId;
        const targetFormResponse = await forms.forms.get({ formId: targetFormId });
        workingForm = targetFormResponse.data;
        summaryTitle = workingForm.info?.title ?? "Oscar ballot";
    } else {
        operation = "copied";
        sourceFormId = extractFormId(options.sourceForm);

        const [sourceFileResponse, sourceFormResponse] = await Promise.all([
            drive.files.get({
                fileId: sourceFormId,
                fields: "id,name",
                supportsAllDrives: true
            }),
            forms.forms.get({ formId: sourceFormId })
        ]);

        const sourceFileName = sourceFileResponse.data.name ?? "Oscar ballot";
        const sourceFormInfo = sourceFormResponse.data.info ?? {};
        const baseTitle = sourceFormInfo.title?.trim() || sourceFileName;
        const copyTitle = options.copyTitle?.trim() || suggestCopyTitle(baseTitle, targetYear);

        const copyResponse = await drive.files.copy({
            fileId: sourceFormId,
            fields: "id,name",
            supportsAllDrives: true,
            requestBody: {
                name: copyTitle
            }
        });

        targetFormId = copyResponse.data.id ?? "";

        if (!targetFormId) {
            throw new Error("Drive copy succeeded but no copied form id was returned.");
        }

        const copiedFormResponse = await getFormWithRetry(forms, targetFormId);
        workingForm = copiedFormResponse.data;
        summaryTitle = copyTitle;
        infoRequests = buildInfoUpdateRequests({
            sourceInfo: workingForm.info ?? sourceFormInfo,
            copyTitle,
            targetYear
        });
    }

    if (infoRequests.length) {
        await forms.forms.batchUpdate({
            formId: targetFormId,
            requestBody: {
                requests: infoRequests
            }
        });
    }

    const updatePlan = buildChoiceUpdatePlan(workingForm.items ?? [], nomineeIndex);
    const textUpdateRequests = buildItemTextUpdateRequests(workingForm.items ?? [], targetYear);

    if (!updatePlan.requests.length && !updatePlan.createRequests.length && !textUpdateRequests.length) {
        throw new Error("No matching choice-based questions were found in the copied form.");
    }

    for (const requestBatch of chunk(updatePlan.requests, FORMS_BATCH_LIMIT)) {
        await forms.forms.batchUpdate({
            formId: targetFormId,
            requestBody: {
                requests: requestBatch
            }
        });
    }

    for (const requestBatch of chunk(textUpdateRequests, FORMS_BATCH_LIMIT)) {
        await forms.forms.batchUpdate({
            formId: targetFormId,
            requestBody: {
                requests: requestBatch
            }
        });
    }

    for (const requestBatch of chunk(updatePlan.createRequests, FORMS_BATCH_LIMIT)) {
        await forms.forms.batchUpdate({
            formId: targetFormId,
            requestBody: {
                requests: requestBatch
            }
        });
    }

    printSummary({
        sourceFormId,
        targetFormId,
        summaryTitle,
        operation,
        createdItems: updatePlan.created,
        updatedCount: updatePlan.updated.length,
        updatedItems: updatePlan.updated,
        skippedItems: updatePlan.skipped,
        unusedCategories: getUnusedCategories(nomineeIndex.categories, updatePlan.updated, updatePlan.created),
        warnings: updatePlan.warnings,
        textUpdatedCount: textUpdateRequests.length
    });
}

function parseArguments(argv) {
    const options = {
        copyTitle: null,
        credentialsPath: DEFAULT_CREDENTIALS_PATH,
        dataPath: DEFAULT_DATA_PATH,
        help: false,
        sourceForm: "",
        targetForm: "",
        tokenPath: DEFAULT_TOKEN_PATH
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === "--help" || argument === "-h") {
            options.help = true;
            continue;
        }

        if (!argument.startsWith("--")) {
            throw new Error(`Unexpected positional argument: ${argument}`);
        }

        const [flag, inlineValue] = argument.split("=", 2);
        const nextValue = inlineValue ?? argv[index + 1];

        if (!inlineValue && !nextValue) {
            throw new Error(`Missing value for ${flag}`);
        }

        switch (flag) {
            case "--source-form-url":
            case "--source-form-id":
                options.sourceForm = nextValue;
                break;
            case "--target-form-url":
            case "--target-form-id":
                options.targetForm = nextValue;
                break;
            case "--copy-title":
                options.copyTitle = nextValue;
                break;
            case "--data":
                options.dataPath = nextValue;
                break;
            case "--credentials":
                options.credentialsPath = nextValue;
                break;
            case "--token":
                options.tokenPath = nextValue;
                break;
            default:
                throw new Error(`Unknown argument: ${flag}`);
        }

        if (!inlineValue) {
            index += 1;
        }
    }

    return options;
}

function printUsage(errorMessage = "") {
    if (errorMessage) {
        console.error(errorMessage);
        console.error("");
    }

    console.log(`Usage:
  npm run copy-google-form -- --source-form-url <google-form-url> [options]
  npm run copy-google-form -- --target-form-url <google-form-url> [options]

Options:
  --target-form-url <url>    Update an existing form in place
  --copy-title <title>       Override the copied Google Drive file name
  --data <path>              Nominee data file (default: ${DEFAULT_DATA_PATH})
  --credentials <path>       OAuth client JSON (default: ${DEFAULT_CREDENTIALS_PATH})
  --token <path>             Saved OAuth token JSON (default: ${DEFAULT_TOKEN_PATH})
  --help                     Show this help text`);
}

async function loadNomineeIndex(dataPath) {
    const raw = await fs.readFile(dataPath, "utf8");
    const payload = JSON.parse(stripLeadingBom(raw));

    if (!Array.isArray(payload.categories) || !payload.categories.length) {
        throw new Error(`No categories found in ${dataPath}`);
    }

    const categories = payload.categories.map((entry) => {
        const nominees = (entry.nominees ?? [])
            .map((nominee) => ({
                nominee: String(nominee.nominee ?? "").trim(),
                yesPrice: Number(nominee.yesPrice ?? Number.NaN)
            }))
            .filter((nominee) => nominee.nominee)
            .sort((left, right) => {
                const leftScore = Number.isFinite(left.yesPrice) ? left.yesPrice : Number.NEGATIVE_INFINITY;
                const rightScore = Number.isFinite(right.yesPrice) ? right.yesPrice : Number.NEGATIVE_INFINITY;

                return rightScore - leftScore;
            })
            .map((nominee, index) => ({
                label: `${index + 1}. ${nominee.nominee}`,
                nominee: nominee.nominee,
                rank: index + 1,
                yesPrice: nominee.yesPrice
            }));

        if (!entry.category || !nominees.length) {
            throw new Error(`Invalid category entry in ${dataPath}: ${JSON.stringify(entry)}`);
        }

        return {
            aliases: buildCategoryAliases(entry.category),
            category: entry.category,
            nominees
        };
    });

    const aliasEntries = categories
        .flatMap((category) => [...category.aliases].map((alias) => ({ alias, category })))
        .sort((left, right) => right.alias.length - left.alias.length);

    return {
        aliasEntries,
        categories,
        year: Number(payload.year) || new Date().getFullYear()
    };
}

function buildCategoryAliases(categoryName) {
    const normalized = normalizeText(categoryName);
    const aliases = new Set([normalized]);
    const withoutBest = normalized.replace(/^best\s+/, "");
    const replacements = [
        [" and ", " "],
        [" feature film", " feature"],
        [" short film", " short"],
        [" makeup and hairstyling", " makeup hairstyling"]
    ];

    if (withoutBest && withoutBest !== normalized) {
        aliases.add(withoutBest);
    }

    for (const [from, to] of replacements) {
        if (normalized.includes(from)) {
            aliases.add(normalized.replace(from, to));
        }

        if (withoutBest.includes(from)) {
            aliases.add(withoutBest.replace(from, to));
        }
    }

    for (const override of CATEGORY_ALIAS_OVERRIDES[categoryName] ?? []) {
        aliases.add(normalizeText(override));
    }

    return aliases;
}

function buildChoiceUpdatePlan(items, nomineeIndex) {
    const requests = [];
    const createRequests = [];
    const created = [];
    const skipped = [];
    const updated = [];
    const warnings = [];
    const matchedCategoryNames = new Set();
    const templateItem = findQuestionTemplate(items);

    items.forEach((item, index) => {
        const title = item.title?.trim() ?? "";
        const choiceQuestion = item.questionItem?.question?.choiceQuestion;

        if (!choiceQuestion) {
            if (title) {
                skipped.push({
                    reason: "not-a-choice-question",
                    title
                });
            }

            return;
        }

        const matchedCategory = matchCategory(item, nomineeIndex.aliasEntries);

        if (!matchedCategory) {
            skipped.push({
                reason: "no-category-match",
                title: title || `(question ${index + 1})`
            });
            return;
        }

        matchedCategoryNames.add(matchedCategory.category);

        const specialOptions = (choiceQuestion.options ?? []).filter((option) =>
            !option.isOther && (option.image || option.goToAction || option.goToSectionId)
        );

        if (specialOptions.length) {
            skipped.push({
                reason: "question-has-special-options",
                title: title || matchedCategory.category
            });
            return;
        }

        const updatedItem = structuredClone(item);
        const updatedChoiceQuestion = updatedItem.questionItem.question.choiceQuestion;
        const existingOptions = updatedChoiceQuestion.options ?? [];
        const preserveOtherOption = existingOptions.some((option) => option.isOther);
        const nextOptions = matchedCategory.nominees.map((nominee) => ({ value: nominee.label }));

        if (preserveOtherOption && updatedChoiceQuestion.type !== "DROP_DOWN") {
            nextOptions.push({ isOther: true, value: "Other" });
        }

        updatedChoiceQuestion.options = nextOptions;

        requests.push({
            updateItem: {
                item: updatedItem,
                location: { index },
                updateMask: "questionItem.question.choiceQuestion.options"
            }
        });

        updated.push({
            category: matchedCategory.category,
            nomineeCount: matchedCategory.nominees.length,
            title: title || matchedCategory.category
        });

        if (updatedItem.questionItem.question.grading?.correctAnswers?.answers?.length) {
            warnings.push(
                `Question "${title || matchedCategory.category}" has existing grading configured. Review its answer key after the nominee refresh.`
            );
        }
    });

    const missingCategories = nomineeIndex.categories.filter(
        (category) => !matchedCategoryNames.has(category.category)
    );

    if (missingCategories.length && templateItem) {
        const insertionIndex = getCreationIndex(items);
        const startingNumber = getNextQuestionNumber(items);

        missingCategories.forEach((category, offset) => {
            const newItem = buildCreatedQuestionItem(templateItem, category, startingNumber + offset);

            createRequests.push({
                createItem: {
                    item: newItem,
                    location: { index: insertionIndex + offset }
                }
            });

            created.push({
                category: category.category,
                nomineeCount: category.nominees.length,
                title: newItem.title
            });
        });
    }

    return { createRequests, created, requests, skipped, updated, warnings };
}

function matchCategory(item, aliasEntries) {
    const searchText = normalizeText([item.title, item.description].filter(Boolean).join(" "));

    if (!searchText) {
        return null;
    }

    const exactMatch = aliasEntries.find(({ alias }) => searchText === alias);

    if (exactMatch) {
        return exactMatch.category;
    }

    const matches = aliasEntries.filter(({ alias }) => searchText.includes(alias));

    if (!matches.length) {
        return null;
    }

    const longestAliasLength = matches[0].alias.length;
    const bestMatches = matches.filter(({ alias }) => alias.length === longestAliasLength);
    const categoryNames = new Set(bestMatches.map(({ category }) => category.category));

    if (categoryNames.size !== 1) {
        return null;
    }

    return bestMatches[0].category;
}

function buildInfoUpdateRequests({ sourceInfo, copyTitle, targetYear }) {
    const requests = [];
    const currentTitle = sourceInfo.title ?? "";
    const currentDescription = sourceInfo.description ?? "";
    const nextTitle = currentTitle
        ? replaceLastYear(currentTitle, targetYear)
        : copyTitle;
    const nextDescription = replaceLastYear(currentDescription, targetYear);

    if (nextTitle && nextTitle !== currentTitle) {
        requests.push({
            updateFormInfo: {
                info: { title: nextTitle },
                updateMask: "title"
            }
        });
    }

    if (currentDescription && nextDescription !== currentDescription) {
        requests.push({
            updateFormInfo: {
                info: { description: nextDescription },
                updateMask: "description"
            }
        });
    }

    return requests;
}

function getUnusedCategories(categories, updatedItems, createdItems = []) {
    const usedCategories = new Set([
        ...updatedItems.map((item) => item.category),
        ...createdItems.map((item) => item.category)
    ]);

    return categories
        .map((category) => category.category)
        .filter((category) => !usedCategories.has(category));
}

function suggestCopyTitle(sourceTitle, targetYear) {
    const updated = replaceLastYear(sourceTitle, targetYear);

    if (updated !== sourceTitle) {
        return updated;
    }

    if (sourceTitle.includes(String(targetYear))) {
        return `${sourceTitle} Copy`;
    }

    return `${sourceTitle} ${targetYear}`;
}

function replaceLastYear(value, targetYear) {
    const previousYear = String(targetYear - 1);
    const target = String(targetYear);

    return String(value).replaceAll(new RegExp(`\\b${previousYear}\\b`, "g"), target);
}

function normalizeText(value) {
    return String(value)
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replaceAll("&", " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function uniqueStrings(values) {
    return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function extractFormId(formReference) {
    const rawValue = String(formReference).trim();
    const urlMatch = rawValue.match(/\/d\/([a-zA-Z0-9_-]+)/);

    if (urlMatch) {
        return urlMatch[1];
    }

    if (/^[a-zA-Z0-9_-]{20,}$/.test(rawValue)) {
        return rawValue;
    }

    throw new Error(`Could not extract a Google Form id from: ${formReference}`);
}

function resolveFromRoot(relativeOrAbsolutePath) {
    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(ROOT_DIR, relativeOrAbsolutePath);
}

async function authorize({ credentialsPath, tokenPath }) {
    const savedCredentials = await loadSavedCredentialsIfExist(tokenPath);

    if (savedCredentials) {
        return savedCredentials;
    }

    return authenticateAndPersistCredentials(credentialsPath, tokenPath);
}

async function loadSavedCredentialsIfExist(tokenPath) {
    try {
        const tokenRaw = await fs.readFile(tokenPath, "utf8");
        return google.auth.fromJSON(JSON.parse(tokenRaw));
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }

        throw new Error(`Failed to load saved token from ${tokenPath}`, { cause: error });
    }
}

async function authenticateAndPersistCredentials(credentialsPath, tokenPath) {
    try {
        await fs.access(credentialsPath);
    } catch (error) {
        throw new Error(
            `Missing OAuth client credentials at ${credentialsPath}. See scripts/google_forms_setup.md for setup instructions.`,
            { cause: error }
        );
    }

    const auth = await authenticate({
        keyfilePath: credentialsPath,
        scopes: SCOPES
    });

    if (auth.credentials?.refresh_token) {
        await saveCredentials(credentialsPath, tokenPath, auth.credentials.refresh_token);
    }

    return auth;
}

async function saveCredentials(credentialsPath, tokenPath, refreshToken) {
    const credentialsRaw = await fs.readFile(credentialsPath, "utf8");
    const credentials = JSON.parse(credentialsRaw);
    const key = credentials.installed ?? credentials.web;

    if (!key?.client_id || !key?.client_secret) {
        throw new Error(`OAuth client JSON at ${credentialsPath} is missing client_id or client_secret.`);
    }

    const payload = {
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: refreshToken,
        type: "authorized_user"
    };

    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, JSON.stringify(payload, null, 2));
}

async function getFormWithRetry(forms, formId, attempts = 5) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await forms.forms.get({ formId });
        } catch (error) {
            lastError = error;
            const statusCode = error?.response?.status;

            if (statusCode !== 404 || attempt === attempts) {
                throw error;
            }

            await sleep(attempt * 1000);
        }
    }

    throw lastError;
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stripLeadingBom(value) {
    return String(value).replace(/^\uFEFF/, "");
}

function chunk(values, size) {
    const chunks = [];

    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }

    return chunks;
}

function buildItemTextUpdateRequests(items, targetYear) {
    const requests = [];

    items.forEach((item, index) => {
        const currentTitle = item.title ?? "";

        if (!/bonus question/i.test(currentTitle)) {
            return;
        }

        const nextTitle = replaceLastYear(currentTitle, targetYear);

        if (nextTitle === currentTitle) {
            return;
        }

        const updatedItem = structuredClone(item);
        updatedItem.title = nextTitle;

        requests.push({
            updateItem: {
                item: updatedItem,
                location: { index },
                updateMask: "title"
            }
        });
    });

    return requests;
}

function printSummary({
    createdItems,
    sourceFormId,
    targetFormId,
    summaryTitle,
    operation,
    updatedCount,
    updatedItems,
    skippedItems,
    unusedCategories,
    warnings,
    textUpdatedCount
}) {
    console.log("");
    console.log(`Form title: ${summaryTitle}`);

    if (operation === "copied") {
        console.log(`Source form id: ${sourceFormId}`);
        console.log(`Copied form id: ${targetFormId}`);
    } else {
        console.log(`Updated form id: ${targetFormId}`);
    }

    console.log(`Edit URL: https://docs.google.com/forms/d/${targetFormId}/edit`);
    console.log(`Live URL: https://docs.google.com/forms/d/${targetFormId}/viewform`);
    console.log(`Updated questions: ${updatedCount}`);

    if (createdItems.length) {
        console.log(`Created questions: ${createdItems.length}`);
    }

    if (textUpdatedCount) {
        console.log(`Updated text items: ${textUpdatedCount}`);
    }

    if (updatedItems.length) {
        console.log("");
        console.log("Updated items:");

        for (const item of updatedItems) {
            console.log(`- ${item.title} -> ${item.nomineeCount} nominees`);
        }
    }

    if (createdItems.length) {
        console.log("");
        console.log("Created items:");

        for (const item of createdItems) {
            console.log(`- ${item.title} -> ${item.nomineeCount} nominees`);
        }
    }

    if (skippedItems.length) {
        console.log("");
        console.log("Skipped items:");

        for (const item of skippedItems) {
            console.log(`- ${item.title}: ${item.reason}`);
        }
    }

    if (unusedCategories.length) {
        console.log("");
        console.log("Unused Oscar categories from the data file:");

        for (const category of unusedCategories) {
            console.log(`- ${category}`);
        }
    }

    if (warnings.length) {
        console.log("");
        console.log("Warnings:");

        for (const warning of warnings) {
            console.log(`- ${warning}`);
        }
    }
}

function findQuestionTemplate(items) {
    for (const item of items) {
        if (item.questionItem?.question?.choiceQuestion) {
            return item;
        }
    }

    return null;
}

function getCreationIndex(items) {
    const tiebreakerIndex = items.findIndex((item) => /^tiebreaker\b/i.test(item.title?.trim() ?? ""));

    if (tiebreakerIndex >= 0) {
        return tiebreakerIndex;
    }

    return items.length;
}

function getNextQuestionNumber(items) {
    const numberedQuestions = items
        .map((item) => {
            const match = item.title?.trim().match(/^(\d+)\./);
            return match ? Number(match[1]) : 0;
        })
        .filter(Boolean);

    if (!numberedQuestions.length) {
        return 1;
    }

    return Math.max(...numberedQuestions) + 1;
}

function buildCreatedQuestionItem(templateItem, category, questionNumber) {
    const templateQuestion = structuredClone(templateItem.questionItem?.question ?? {});

    delete templateQuestion.questionId;
    delete templateQuestion.grading;

    templateQuestion.choiceQuestion = {
        ...templateQuestion.choiceQuestion,
        options: category.nominees.map((nominee) => ({ value: nominee.label }))
    };

    return {
        title: `${questionNumber}. ${category.category}`,
        questionItem: {
            question: templateQuestion
        }
    };
}
