# Kcal Calc

Kcal Calc is an Obsidian plugin that scans the active Markdown note for ingredient lines, looks up matching foods through USDA FoodData Central, appends kcal values, and adds an underlined total.

For the plugin to work, you will need to add your API key in the plugin settings, you can get your API key for free here https://fdc.nal.usda.gov/api-key-signup

<img width="531" height="229" alt="image" src="https://github.com/user-attachments/assets/ed67f85f-0fcc-47b1-839d-a78dd9b7eb95" />


## Network use and privacy

Kcal Calc uses the USDA FoodData Central API at `https://api.nal.usda.gov/fdc/v1/foods/search` to look up ingredient nutrition data. When you run the annotation command, the plugin sends each ingredient search query and your USDA API key to USDA FoodData Central. This network access is required for nutrition lookup.

Kcal Calc does not include telemetry, advertising, automatic update mechanisms, or access files outside your Obsidian vault.

## Ingredient format

Use one ingredient per line:

```md
dark chocolate - 200g
banana - 120g
```

The default delimiter is ` - `. You can change it in the plugin settings, for example to ` : ` if you prefer:

```md
dark chocolate : 200g
banana : 120g
```

Bullet lines are also supported:

```md
- dark chocolate - 200g
- banana - 120g
```

After running the command and accepting the preview, the note is rewritten like this:

```md
dark chocolate - 200g (1092 kcal, P 15.6g, C 91.6g, F 85.6g)
banana - 120g (107 kcal, P 1.3g, C 27.4g, F 0.4g)

<u>Total kcal: 1199 kcal, P 16.9g, C 119g, F 86g</u>
```

The command is idempotent: running it again updates the kcal annotations and replaces the previous total line.

## Meal sections

If your note uses Markdown headings, Kcal Calc can add section totals before the next heading:

```md
## Breakfast
banana - 120g
Greek yogurt - 250g

## Dinner
rice - 200g
chicken breast - 180g
```

This produces underlined `Section kcal` totals for each heading and one final `Total kcal` line for the whole note.

## Match preview and confidence

Before applying changes, the plugin shows a preview of each typed ingredient, the USDA food it matched, its kcal/macros, and a confidence value.

If a match needs review, the note line gets a marker like this:

```md
dark choclate - 200g (1092 kcal, P 15.6g, C 91.6g, F 85.6g) [? matched: Chocolate, dark, 70-85% cacao solids]
```

This helps catch misspellings and surprising USDA matches without blocking the workflow.

## Preferred foods

In settings, add preferred food aliases one per line:

```text
whey = Whey protein powder
dark choc = Chocolate, dark, 70-85% cacao solids
skyr = Yogurt, Greek, plain, nonfat
```

When the note contains `whey - 30g`, the plugin searches USDA for `Whey protein powder` while preserving the original note text.

You can also use JSON if you prefer:

```json
{
	"whey": "Whey protein powder",
	"dark choc": "Chocolate, dark, 70-85% cacao solids"
}
```

## Settings

- `Ingredient delimiter`: defaults to ` - `.
- `Include macros`: adds protein, carbs, and fat when USDA provides them.
- `Add section totals`: totals each Markdown heading section.
- `Show match preview`: asks before rewriting the note.
- `Mark low-confidence matches`: appends review markers for suspicious matches.
- `Preferred foods`: alias dictionary for consistent USDA searches.

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Build the plugin:

```powershell
npm run build
```

3. Copy these files into your vault at `.obsidian/plugins/kcal-calc/`:

```text
main.js
manifest.json
styles.css
```

4. Enable the plugin in Obsidian and add your USDA FoodData Central API key in the plugin settings.

## Commands

- `Annotate ingredient kcal in active note`

The ribbon calculator icon runs the same action.

## License

MIT
