export function parseArgs(argv: string[]) {
  const args = { resume: "", cont: false, print: "", model: "", provider: "", theme: "", auto: false, yolo: false, plan: false, mcpServer: false, noMcp: false, noLsp: false, noCron: false, help: false, version: false, exportId: "", exportFormat: "md" as "md" | "json", gui: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" && argv[i + 1]) args.resume = argv[++i];
    else if (argv[i] === "--continue") args.cont = true;
    else if (argv[i] === "-p" && argv[i + 1]) args.print = argv[++i];
    else if (argv[i] === "--export" && argv[i + 1]) args.exportId = argv[++i];
    else if (argv[i] === "--format" && (argv[i + 1] === "md" || argv[i + 1] === "json")) args.exportFormat = argv[++i] as "md" | "json";
    else if (argv[i] === "--model" && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === "--provider" && argv[i + 1]) args.provider = argv[++i];
    else if (argv[i] === "--theme" && argv[i + 1]) args.theme = argv[++i];
    else if (argv[i] === "--port" && argv[i + 1]) args.port = Number(argv[++i]) || 0;
    else if (argv[i] === "--auto") args.auto = true;
    else if (argv[i] === "--yolo") args.yolo = true;
    else if (argv[i] === "--plan") args.plan = true;
    else if (argv[i] === "--mcp-server") args.mcpServer = true;
    else if (argv[i] === "--no-mcp") args.noMcp = true;
    else if (argv[i] === "--no-lsp") args.noLsp = true;
    else if (argv[i] === "--no-cron") args.noCron = true;
    else if (argv[i] === "--gui") args.gui = true;
    else if (argv[i] === "-h" || argv[i] === "--help") args.help = true;
    else if (argv[i] === "-v" || argv[i] === "--version") args.version = true;
  }
  return args;
}

export type CliArgs = ReturnType<typeof parseArgs>;
