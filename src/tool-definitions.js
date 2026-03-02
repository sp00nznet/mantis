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
      description: "Make a surgical edit to a file by replacing a specific string with a new string. The old_string must match exactly (including whitespace and indentation).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to edit"
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace. Must be unique in the file."
          },
          new_string: {
            type: "string",
            description: "The string to replace old_string with"
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
            enum: ["project", "global"],
            description: "Which memory to clear: 'project' or 'global'."
          }
        },
        required: ["scope"]
      }
    }
  }
];

// Read-only subset for swarm workers — no write/edit/run capabilities
export const readOnlyToolDefinitions = toolDefinitions.filter(t =>
  ['read_file', 'list_files', 'search_files', 'find_files', 'read_memory']
    .includes(t.function.name)
);
