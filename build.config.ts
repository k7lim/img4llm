import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
    entries: [
        {
            input: "src/",
            outDir: "lib/",
            declaration: true,
            pattern: "*.ts",
            format: "esm",
        },
        {
            input: "src/",
            pattern: "*.ts",
            declaration: true,
            outDir: "lib/",
            format: "cjs",
            ext: "cjs",
        },
    ],
});
