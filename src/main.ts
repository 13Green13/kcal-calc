import {
  App,
  Editor,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting
} from "obsidian";

const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const ENERGY_NUTRIENT_ID = 1008;
const PROTEIN_NUTRIENT_ID = 1003;
const FAT_NUTRIENT_ID = 1004;
const CARBS_NUTRIENT_ID = 1005;
const DEFAULT_INGREDIENT_DELIMITER = " - ";
const TOTAL_LINE_REGEX = /^\s*<u>(?:Total kcal|Section kcal): .+<\/u>\s*$/i;
const HEADING_REGEX = /^#{1,6}\s+.+$/;
const LOW_CONFIDENCE_THRESHOLD = 0.75;

interface KcalCalcSettings {
  usdaApiKey: string;
  ingredientDelimiter: string;
  includeMacros: boolean;
  addSectionTotals: boolean;
  showMatchPreview: boolean;
  markLowConfidenceMatches: boolean;
  preferredFoods: string;
}

const DEFAULT_SETTINGS: KcalCalcSettings = {
  usdaApiKey: "",
  ingredientDelimiter: DEFAULT_INGREDIENT_DELIMITER,
  includeMacros: true,
  addSectionTotals: true,
  showMatchPreview: true,
  markLowConfidenceMatches: true,
  preferredFoods: ""
};

interface FoodSearchResponse {
  foods?: FoodSearchResult[];
}

interface FoodSearchResult {
  description?: string;
  foodNutrients?: FoodNutrient[];
}

interface FoodNutrient {
  nutrientId?: number;
  nutrientName?: string;
  unitName?: string;
  value?: number;
  amount?: number;
}

interface ParsedIngredientLine {
  prefix: string;
  foodName: string;
  amountText: string;
  unitText: string;
  grams: number;
}

interface NutritionValues {
  kcal: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

interface NutritionTotals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface FoodLookupResult {
  matchedDescription: string;
  searchQuery: string;
  usedPreferredFood: boolean;
  nutritionPer100g: NutritionValues;
  confidence: number;
  needsReview: boolean;
}

interface AnnotatedIngredient {
  inputName: string;
  lookup: FoodLookupResult;
  nutrition: NutritionValues;
}

interface AnnotationResult {
  annotatedText: string;
  annotatedLines: number;
  skippedFoods: string[];
  totalKcal: number;
  totalNutrition?: NutritionTotals;
  ingredients?: AnnotatedIngredient[];
}

export default class KcalCalcPlugin extends Plugin {
  settings!: KcalCalcSettings;
  private readonly lookupCache = new Map<string, FoodLookupResult | null>();

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("calculator", "Annotate ingredient kcal", async () => {
      await this.annotateActiveMarkdownNote();
    });

    this.addCommand({
      id: "annotate-ingredient-kcal",
      name: "Annotate ingredient kcal in active note",
      editorCallback: async (editor: Editor) => {
        await this.annotateEditor(editor);
      }
    });

    this.addSettingTab(new KcalCalcSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  clearLookupCache() {
    this.lookupCache.clear();
  }

  private async annotateActiveMarkdownNote() {
    const activeLeaf = this.app.workspace.activeEditor;
    const editor = activeLeaf?.editor;

    if (!editor) {
      new Notice("Open a Markdown note before annotating kcal.");
      return;
    }

    await this.annotateEditor(editor);
  }

  private async annotateEditor(editor: Editor) {
    if (!this.settings.usdaApiKey.trim()) {
      new Notice("Add your USDA FoodData Central API key in Kcal Calc settings.");
      return;
    }

    try {
      const result = await this.annotateText(editor.getValue());

      if (result.annotatedLines === 0) {
        new Notice(`No ingredient lines found. Use: dark chocolate${this.getIngredientDelimiter()}200g`);
        return;
      }

      if (this.settings.showMatchPreview) {
        const shouldApply = await new MatchPreviewModal(this.app, result, this.settings.includeMacros).openAndWait();

        if (!shouldApply) {
          new Notice("Kcal annotation cancelled.");
          return;
        }
      }

      editor.setValue(result.annotatedText);

      const skippedText = result.skippedFoods.length > 0
        ? ` Skipped: ${result.skippedFoods.join(", ")}.`
        : "";

      new Notice(`Annotated ${result.annotatedLines} line(s), total ${formatKcal(result.totalNutrition?.kcal ?? result.totalKcal)} kcal.${skippedText}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Kcal Calc failed: ${message}`);
    }
  }

  private async annotateText(text: string): Promise<AnnotationResult> {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const ingredientDelimiter = this.getIngredientDelimiter();
    const preferredFoods = parsePreferredFoods(this.settings.preferredFoods);
    const annotatedLines: string[] = [];
    const skippedFoods: string[] = [];
    const ingredients: AnnotatedIngredient[] = [];
    const totalNutrition = createEmptyTotals();
    let sectionNutrition = createEmptyTotals();
    let changedLineCount = 0;
    let sectionHasHeading = false;
    let sectionAnnotatedLines = 0;

    const pushSectionTotal = () => {
      if (!this.settings.addSectionTotals || !sectionHasHeading || sectionAnnotatedLines === 0) {
        return;
      }

      if (annotatedLines.length > 0 && annotatedLines[annotatedLines.length - 1].trim() !== "") {
        annotatedLines.push("");
      }

      annotatedLines.push(`<u>Section kcal: ${formatNutritionTotals(sectionNutrition, this.settings.includeMacros)}</u>`);
      sectionNutrition = createEmptyTotals();
      sectionAnnotatedLines = 0;
    };

    for (const line of lines) {
      if (TOTAL_LINE_REGEX.test(line)) {
        continue;
      }

      if (HEADING_REGEX.test(line)) {
        pushSectionTotal();
        annotatedLines.push(line);
        sectionHasHeading = true;
        sectionNutrition = createEmptyTotals();
        sectionAnnotatedLines = 0;
        continue;
      }

      const ingredientLine = parseIngredientLine(line, ingredientDelimiter);

      if (!ingredientLine) {
        annotatedLines.push(line);
        continue;
      }

      const lookup = await this.findFoodNutrition(ingredientLine.foodName, preferredFoods);

      if (lookup === null) {
        skippedFoods.push(ingredientLine.foodName);
        annotatedLines.push(line);
        continue;
      }

      const nutrition = scaleNutrition(lookup.nutritionPer100g, ingredientLine.grams);
      addNutrition(totalNutrition, nutrition);
      addNutrition(sectionNutrition, nutrition);
      changedLineCount += 1;
      sectionAnnotatedLines += 1;
      ingredients.push({
        inputName: ingredientLine.foodName,
        lookup,
        nutrition
      });
      annotatedLines.push(formatIngredientLine(ingredientLine, ingredientDelimiter, lookup, nutrition, this.settings));
    }

    pushSectionTotal();

    if (changedLineCount > 0) {
      if (annotatedLines.length > 0 && annotatedLines[annotatedLines.length - 1].trim() !== "") {
        annotatedLines.push("");
      }

      annotatedLines.push(`<u>Total kcal: ${formatNutritionTotals(totalNutrition, this.settings.includeMacros)}</u>`);
    }

    return {
      annotatedText: annotatedLines.join(newline),
      annotatedLines: changedLineCount,
      skippedFoods,
      totalKcal: totalNutrition.kcal,
      totalNutrition,
      ingredients
    };
  }

  private async findFoodNutrition(foodName: string, preferredFoods: Map<string, string>): Promise<FoodLookupResult | null> {
    const preferredQuery = preferredFoods.get(normalizePreferredFoodKey(foodName));
    const searchQuery = preferredQuery ?? foodName;
    const cacheKey = `${normalizePreferredFoodKey(foodName)}\u0000${normalizePreferredFoodKey(searchQuery)}`;

    if (this.lookupCache.has(cacheKey)) {
      return this.lookupCache.get(cacheKey) ?? null;
    }

    const searchParams = new URLSearchParams({
      api_key: this.settings.usdaApiKey.trim(),
      query: searchQuery,
      pageSize: "5"
    });

    const response = await requestUrl({
      url: `${USDA_SEARCH_URL}?${searchParams.toString()}`,
      method: "GET"
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error("USDA API key was rejected.");
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`USDA search returned HTTP ${response.status}.`);
    }

    const data = response.json as FoodSearchResponse;
    const lookup = findFirstNutritionResult(data.foods ?? [], searchQuery, preferredQuery !== undefined);
    this.lookupCache.set(cacheKey, lookup);

    return lookup;
  }

  private getIngredientDelimiter(): string {
    return this.settings.ingredientDelimiter || DEFAULT_INGREDIENT_DELIMITER;
  }
}

class MatchPreviewModal extends Modal {
  private resolved = false;
  private resolveResult?: (shouldApply: boolean) => void;

  constructor(
    app: App,
    private readonly result: AnnotationResult,
    private readonly includeMacros: boolean
  ) {
    super(app);
  }

  openAndWait(): Promise<boolean> {
    this.open();

    return new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kcal-calc-preview");

    contentEl.createEl("h2", { text: "Kcal Calc match preview" });
    contentEl.createEl("p", {
      text: `Review ${this.result.annotatedLines} USDA match(es) before updating the note.`
    });

    const table = contentEl.createEl("table");
    const header = table.createEl("thead").createEl("tr");
    ["Ingredient", "USDA match", "Nutrition", "Confidence"].forEach((label) => {
      header.createEl("th", { text: label });
    });

    const body = table.createEl("tbody");

    for (const ingredient of this.result.ingredients ?? []) {
      const row = body.createEl("tr");
      row.createEl("td", { text: ingredient.inputName });
      row.createEl("td", {
        text: ingredient.lookup.usedPreferredFood
          ? `${ingredient.lookup.matchedDescription} (preferred: ${ingredient.lookup.searchQuery})`
          : ingredient.lookup.matchedDescription
      });
      row.createEl("td", { text: formatNutritionValues(ingredient.nutrition, this.includeMacros) });
      row.createEl("td", {
        text: ingredient.lookup.needsReview
          ? `Review (${formatConfidence(ingredient.lookup.confidence)})`
          : formatConfidence(ingredient.lookup.confidence)
      });
    }

    if (this.result.skippedFoods.length > 0) {
      const skipped = contentEl.createEl("p");
      skipped.addClass("kcal-calc-preview-warning");
      skipped.setText(`No kcal match found for: ${this.result.skippedFoods.join(", ")}.`);
    }

    contentEl.createEl("p", {
      text: `Total: ${formatNutritionTotals(this.result.totalNutrition ?? kcalOnlyTotal(this.result.totalKcal), this.includeMacros)}`
    });

    const actions = contentEl.createDiv({ cls: "kcal-calc-preview-actions" });
    const applyButton = actions.createEl("button", { text: "Apply" });
    applyButton.addClass("mod-cta");
    applyButton.addEventListener("click", () => this.finish(true));

    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.finish(false));
  }

  onClose() {
    if (!this.resolved) {
      this.finish(false);
    }
  }

  private finish(shouldApply: boolean) {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.resolveResult?.(shouldApply);
    this.close();
  }
}

function findFirstNutritionResult(
  foods: FoodSearchResult[],
  searchQuery: string,
  usedPreferredFood: boolean
): FoodLookupResult | null {
  for (const food of foods) {
    const nutritionPer100g = findNutritionValues(food);

    if (nutritionPer100g === null) {
      continue;
    }

    const matchedDescription = food.description ?? searchQuery;
    const matchQuality = getMatchQuality(searchQuery, matchedDescription);

    return {
      matchedDescription,
      searchQuery,
      usedPreferredFood,
      nutritionPer100g,
      confidence: matchQuality.confidence,
      needsReview: matchQuality.needsReview
    };
  }

  return null;
}

function findNutritionValues(food: FoodSearchResult): NutritionValues | null {
  const kcal = findNutrientValue(food, ENERGY_NUTRIENT_ID, "kcal");

  if (kcal === null) {
    return null;
  }

  return {
    kcal,
    protein: findNutrientValue(food, PROTEIN_NUTRIENT_ID, "g"),
    carbs: findNutrientValue(food, CARBS_NUTRIENT_ID, "g"),
    fat: findNutrientValue(food, FAT_NUTRIENT_ID, "g")
  };
}

function findNutrientValue(food: FoodSearchResult, nutrientId: number, unitName: string): number | null {
  const nutrients = food.foodNutrients ?? [];

  for (const nutrient of nutrients) {
    const value = typeof nutrient.value === "number"
      ? nutrient.value
      : typeof nutrient.amount === "number"
        ? nutrient.amount
        : null;

    if (nutrient.nutrientId === nutrientId && nutrient.unitName?.toLowerCase() === unitName && value !== null) {
      return value;
    }
  }

  return null;
}

function scaleNutrition(nutritionPer100g: NutritionValues, grams: number): NutritionValues {
  const scale = grams / 100;

  return {
    kcal: nutritionPer100g.kcal * scale,
    protein: scaleNullableMacro(nutritionPer100g.protein, scale),
    carbs: scaleNullableMacro(nutritionPer100g.carbs, scale),
    fat: scaleNullableMacro(nutritionPer100g.fat, scale)
  };
}

function scaleNullableMacro(value: number | null, scale: number): number | null {
  return value === null ? null : value * scale;
}

function createEmptyTotals(): NutritionTotals {
  return {
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0
  };
}

function kcalOnlyTotal(kcal: number): NutritionTotals {
  return {
    kcal,
    protein: 0,
    carbs: 0,
    fat: 0
  };
}

function addNutrition(total: NutritionTotals, nutrition: NutritionValues) {
  total.kcal += nutrition.kcal;
  total.protein += nutrition.protein ?? 0;
  total.carbs += nutrition.carbs ?? 0;
  total.fat += nutrition.fat ?? 0;
}

function parsePreferredFoods(preferredFoods: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const trimmedPreferredFoods = preferredFoods.trim();

  if (trimmedPreferredFoods.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedPreferredFoods) as Record<string, unknown>;

      for (const [alias, query] of Object.entries(parsed)) {
        if (typeof query === "string" && alias.trim() && query.trim()) {
          aliases.set(normalizePreferredFoodKey(alias), query.trim());
        }
      }

      return aliases;
    } catch {
      return aliases;
    }
  }

  for (const line of preferredFoods.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separator = trimmedLine.includes("=>") ? "=>" : "=";
    const separatorIndex = trimmedLine.indexOf(separator);

    if (separatorIndex === -1) {
      continue;
    }

    const alias = trimmedLine.slice(0, separatorIndex).trim();
    const query = trimmedLine.slice(separatorIndex + separator.length).trim();

    if (alias && query) {
      aliases.set(normalizePreferredFoodKey(alias), query);
    }
  }

  return aliases;
}

function normalizePreferredFoodKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getMatchQuality(input: string, match: string): { confidence: number; needsReview: boolean } {
  const inputTokens = tokenizeForMatch(input);
  const matchTokens = tokenizeForMatch(match);

  if (inputTokens.length === 0 || matchTokens.length === 0) {
    return { confidence: 0, needsReview: true };
  }

  let matchedTokens = 0;
  let approximateMatches = 0;

  for (const inputToken of inputTokens) {
    if (matchTokens.includes(inputToken)) {
      matchedTokens += 1;
      continue;
    }

    if (matchTokens.some((matchToken) => areCloseTokens(inputToken, matchToken))) {
      matchedTokens += 1;
      approximateMatches += 1;
    }
  }

  const confidence = matchedTokens / inputTokens.length;

  return {
    confidence,
    needsReview: confidence < LOW_CONFIDENCE_THRESHOLD || approximateMatches > 0
  };
}

function tokenizeForMatch(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/s$/, ""))
    .filter((token) => token.length > 1);
}

function areCloseTokens(inputToken: string, matchToken: string): boolean {
  if (inputToken.length < 4 || matchToken.length < 4) {
    return false;
  }

  return levenshteinDistance(inputToken, matchToken) / Math.max(inputToken.length, matchToken.length) <= 0.22;
}

function levenshteinDistance(left: string, right: string): number {
  const distances = Array.from({ length: left.length + 1 }, (_, index) => index);

  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let previousDistance = distances[0];
    distances[0] = rightIndex;

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const currentDistance = distances[leftIndex];
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      distances[leftIndex] = Math.min(
        distances[leftIndex] + 1,
        distances[leftIndex - 1] + 1,
        previousDistance + substitutionCost
      );
      previousDistance = currentDistance;
    }
  }

  return distances[left.length];
}

class KcalCalcSettingTab extends PluginSettingTab {
  plugin: KcalCalcPlugin;

  constructor(app: App, plugin: KcalCalcPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("USDA API key")
      .setDesc("Used for FoodData Central ingredient searches.")
      .addText((text) => {
        text
          .setPlaceholder("api.data.gov key")
          .setValue(this.plugin.settings.usdaApiKey)
          .onChange(async (value) => {
            this.plugin.settings.usdaApiKey = value.trim();
            this.plugin.clearLookupCache();
            await this.plugin.saveSettings();
          });

        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Ingredient delimiter")
      .setDesc("Separates the food name from the amount. Spaces are kept exactly as typed.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_INGREDIENT_DELIMITER)
          .setValue(this.plugin.settings.ingredientDelimiter)
          .onChange(async (value) => {
            this.plugin.settings.ingredientDelimiter = value || DEFAULT_INGREDIENT_DELIMITER;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Include macros")
      .setDesc("Add protein, carbs, and fat next to each kcal value when USDA provides them.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeMacros)
          .onChange(async (value) => {
            this.plugin.settings.includeMacros = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Add section totals")
      .setDesc("Add an underlined section total before the next Markdown heading.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.addSectionTotals)
          .onChange(async (value) => {
            this.plugin.settings.addSectionTotals = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show match preview")
      .setDesc("Review USDA matches before the note is changed.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showMatchPreview)
          .onChange(async (value) => {
            this.plugin.settings.showMatchPreview = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Mark low-confidence matches")
      .setDesc("Append a review marker when the ingredient differs from the USDA match.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.markLowConfidenceMatches)
          .onChange(async (value) => {
            this.plugin.settings.markLowConfidenceMatches = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Preferred foods")
      .setDesc("One alias per line, for example: whey = Whey protein powder")
      .addTextArea((text) => {
        text
          .setPlaceholder("whey = Whey protein powder\ndark choc = Chocolate, dark, 70-85% cacao solids")
          .setValue(this.plugin.settings.preferredFoods)
          .onChange(async (value) => {
            this.plugin.settings.preferredFoods = value;
            this.plugin.clearLookupCache();
            await this.plugin.saveSettings();
          });

        text.inputEl.rows = 6;
      });
  }
}

function parseIngredientLine(line: string, ingredientDelimiter: string): ParsedIngredientLine | null {
  const ingredientLineRegex = buildIngredientLineRegex(ingredientDelimiter);
  const match = line.match(ingredientLineRegex);

  if (!match) {
    return null;
  }

  const amount = Number(match[3].replace(",", "."));
  const grams = toGrams(amount, match[4]);

  if (!Number.isFinite(grams) || grams <= 0) {
    return null;
  }

  return {
    prefix: match[1],
    foodName: match[2].trim(),
    amountText: match[3],
    unitText: normalizeUnit(match[4]),
    grams
  };
}

function buildIngredientLineRegex(ingredientDelimiter: string): RegExp {
  return new RegExp(`^(\\s*(?:[-*]\\s+)?)((?!total\\b).+?)${escapeRegExp(ingredientDelimiter)}(\\d+(?:[.,]\\d+)?)\\s*(g|gram|grams|kg|kilogram|kilograms)\\b(?:\\s*\\([^)]*kcal[^)]*\\))?(?:\\s*\\[\\? matched: .+\\])?\\s*$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toGrams(amount: number, unit: string): number {
  const normalizedUnit = unit.toLowerCase();

  if (normalizedUnit === "kg" || normalizedUnit === "kilogram" || normalizedUnit === "kilograms") {
    return amount * 1000;
  }

  return amount;
}

function normalizeUnit(unit: string): string {
  const normalizedUnit = unit.toLowerCase();

  if (normalizedUnit === "kg" || normalizedUnit === "kilogram" || normalizedUnit === "kilograms") {
    return "kg";
  }

  return "g";
}

function findFirstKcalValue(foods: FoodSearchResult[]): number | null {
  for (const food of foods) {
    const kcalValue = findKcalValue(food);

    if (kcalValue !== null) {
      return kcalValue;
    }
  }

  return null;
}

function findKcalValue(food: FoodSearchResult): number | null {
  const nutrients = food.foodNutrients ?? [];

  for (const nutrient of nutrients) {
    const isEnergy = nutrient.nutrientId === ENERGY_NUTRIENT_ID
      || nutrient.nutrientName?.toLowerCase() === "energy";
    const isKcal = nutrient.unitName?.toLowerCase() === "kcal";
    const value = typeof nutrient.value === "number"
      ? nutrient.value
      : typeof nutrient.amount === "number"
        ? nutrient.amount
        : null;

    if (isEnergy && isKcal && value !== null) {
      return value;
    }
  }

  return null;
}

function formatIngredientLine(
  ingredientLine: ParsedIngredientLine,
  ingredientDelimiter: string,
  lookup: FoodLookupResult,
  nutrition: NutritionValues,
  settings: KcalCalcSettings
): string {
  const confidenceWarning = settings.markLowConfidenceMatches && lookup.needsReview
    ? ` [? matched: ${truncateText(lookup.matchedDescription, 72)}]`
    : "";

  return `${ingredientLine.prefix}${ingredientLine.foodName}${ingredientDelimiter}${ingredientLine.amountText}${ingredientLine.unitText} (${formatNutritionValues(nutrition, settings.includeMacros)})${confidenceWarning}`;
}

function formatNutritionValues(nutrition: NutritionValues, includeMacros: boolean): string {
  if (!includeMacros) {
    return `${formatKcal(nutrition.kcal)} kcal`;
  }

  return `${formatKcal(nutrition.kcal)} kcal, P ${formatMacro(nutrition.protein)}g, C ${formatMacro(nutrition.carbs)}g, F ${formatMacro(nutrition.fat)}g`;
}

function formatNutritionTotals(nutrition: NutritionTotals, includeMacros: boolean): string {
  if (!includeMacros) {
    return `${formatKcal(nutrition.kcal)} kcal`;
  }

  return `${formatKcal(nutrition.kcal)} kcal, P ${formatMacro(nutrition.protein)}g, C ${formatMacro(nutrition.carbs)}g, F ${formatMacro(nutrition.fat)}g`;
}

function formatKcal(kcal: number): string {
  return String(Math.round(kcal));
}

function formatMacro(macro: number | null): string {
  return macro === null ? "?" : String(Math.round(macro * 10) / 10);
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}