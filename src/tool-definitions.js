export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Use this before editing any file. Supports optional line range.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to read"
          },
          start_line: {
            type: "integer",
            description: "Optional starting line number (1-indexed)"
          },
          end_line: {
            type: "integer",
            description: "Optional ending line number (1-indexed, inclusive)"
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or completely overwrite an existing file with new content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to write"
          },
          content: {
            type: "string",
            description: "The full content to write to the file"
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make a surgical edit to a file by replacing a specific string with a new string. The old_string must match exactly (including whitespace and indentation). Set replace_all=true to replace ALL occurrences at once (useful for renaming variables, classes, etc).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to edit"
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace. Must be unique in the file unless replace_all is true."
          },
          new_string: {
            type: "string",
            description: "The string to replace old_string with"
          },
          replace_all: {
            type: "boolean",
            description: "If true, replace ALL occurrences of old_string in the file. Useful for renaming variables, functions, or classes across the entire file."
          }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command and return its stdout and stderr. Use for git, npm, build tools, tests, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute"
          },
          cwd: {
            type: "string",
            description: "Optional working directory for the command (defaults to current working directory)"
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories. Use to understand project structure.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (defaults to current directory)"
          },
          recursive: {
            type: "boolean",
            description: "If true, list files recursively (max 200 entries). Defaults to false."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search file contents using a regex pattern (like grep). Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for"
          },
          path: {
            type: "string",
            description: "Directory or file to search in (defaults to current directory)"
          },
          file_pattern: {
            type: "string",
            description: "Optional glob pattern to filter files (e.g. '*.js', '*.py')"
          }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files by name using a glob pattern. Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern to match (e.g. '**/*.js', 'src/**/*.ts', '*.json')"
          },
          path: {
            type: "string",
            description: "Base directory to search from (defaults to current directory)"
          }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save persistent notes to memory that will be available in future sessions. Use this when the user asks you to 'remember', 'save state', 'save to memory', or when you want to preserve important context across sessions. You can either replace the entire memory or append to it.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The markdown content to save. Should be well-organized with headers. Include: what you were working on, key decisions, important file paths, task progress, user preferences, anything needed to resume."
          },
          scope: {
            type: "string",
            enum: ["project", "global"],
            description: "Where to save: 'project' saves to .mantis/MEMORY.md (for this project, shareable via git), 'global' saves to ~/.mantis/memory/MEMORY.md (available everywhere). Default: project."
          },
          mode: {
            type: "string",
            enum: ["replace", "append"],
            description: "How to save: 'replace' overwrites existing memory, 'append' adds to the end. Default: replace."
          }
        },
        required: ["content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description: "Read the current persistent memory. Use this to check what was previously saved before updating it.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description: "Which memory to read: 'project', 'global', or 'all' (both). Default: all."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Clear persistent memory. Use when the user asks to forget everything or clear memory.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["project", "global", "handoff"],
            description: "Which memory to clear: 'project', 'global', or 'handoff' (removes the handoff task file)."
          }
        },
        required: ["scope"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Download a web page or URL and return its content. By default HTML is stripped to readable text; set raw=true to get the actual page source (HTML/CSS/JS) — needed when cloning or analysing a page's markup and styles.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The http(s) URL to fetch"
          },
          raw: {
            type: "boolean",
            description: "If true, return the raw source instead of stripped text. Use for cloning or inspecting markup/styles."
          }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and return results. Use to look up current information, library docs, error messages, or APIs you are unsure about. Follow up with web_fetch to read a result in full.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_subagent",
      description: "Delegate a focused subtask to a fresh sub-agent that has its own context and the full tool set. Use for self-contained work — exploring an unfamiliar area, implementing one module, or researching — so the main conversation stays uncluttered. The sub-agent cannot see this conversation, so the task must be fully self-described. Returns the sub-agent's final report.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "A complete, self-contained description of the subtask, including all context the sub-agent needs."
          }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generate an image from a text prompt and save it to a file. Use for icons, illustrations, hero images, placeholder graphics, or other visual assets a project needs.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "A detailed description of the image to generate"
          },
          path: {
            type: "string",
            description: "Where to save the image, relative to the working directory. Defaults to generated-image.png"
          },
          size: {
            type: "string",
            description: "Optional image size, e.g. '1024x1024', '1536x1024', '1024x1536'"
          }
        },
        required: ["prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_speech",
      description: "Generate spoken audio from text (text-to-speech) and save it to an audio file. Use to produce voice-overs or audio assets.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The text to speak"
          },
          path: {
            type: "string",
            description: "Where to save the audio file, relative to the working directory. Defaults to generated-speech.mp3"
          },
          voice: {
            type: "string",
            description: "Optional voice name (provider-dependent, e.g. 'alloy', 'nova', 'echo')"
          }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_skill",
      description: "Save a reusable workflow as a skill so it can be re-run later as /<name>. Use this after you work out a non-trivial, repeatable procedure (a build/release flow, a project-specific check, a multi-step task the user is likely to want again) — capture the steps as a skill instead of relearning them next time. Skills are saved in the portable agentskills.io format.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short kebab-case skill name (becomes the /command). e.g. 'release', 'lint-fix'"
          },
          description: {
            type: "string",
            description: "One line on what the skill does and when to use it"
          },
          instructions: {
            type: "string",
            description: "The skill body: the step-by-step procedure the agent should follow when the skill runs. Markdown. May use {{args}} for invocation arguments."
          },
          argument_hint: {
            type: "string",
            description: "Optional hint for what arguments the skill takes, e.g. '<file>' or '[branch]'"
          },
          scope: {
            type: "string",
            enum: ["user", "project"],
            description: "'user' = available everywhere (~/.mantis/skills), 'project' = committed with this repo (.mantis/skills). Default 'user'."
          }
        },
        required: ["name", "description", "instructions"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Search across past conversations (this and other sessions) and the memory store for relevant context. Use this to recall earlier decisions, prior work on a topic, file names, or how a problem was solved before — instead of asking the user to repeat themselves.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for — keywords or a natural-language description of the topic"
          },
          limit: {
            type: "integer",
            description: "Maximum number of results to return (default 8)"
          }
        },
        required: ["query"]
      }
    }
  }
];

// Read-only subset for swarm workers — no write/edit/run capabilities
export const readOnlyToolDefinitions = toolDefinitions.filter(t =>
  ['read_file', 'list_files', 'search_files', 'find_files', 'read_memory', 'search_memory', 'web_fetch', 'web_search']
    .includes(t.function.name)
);
