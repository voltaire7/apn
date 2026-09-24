-- Session-only APN support. Source this file; nothing is installed in your config.
local script = debug.getinfo(1, "S").source:sub(2)
local root = vim.fn.fnamemodify(script, ":p:h:h:h")
vim.filetype.add({ extension = { apn = "apn" } })
local group = vim.api.nvim_create_augroup("ApnLocal", { clear = true })
-- Filetype-scoped groups leave the rest of your theme alone.
local function colors()
    local palette = {
        number = "#e5c890", string = "#a6d189", comment = "#737994",
        keyword = "#ca9ee6", ["function"] = "#8caaee", type = "#99d1db",
        operator = "#ef9f76", punctuation = "#838ba7",
    }
    for kind, color in pairs(palette) do
        vim.api.nvim_set_hl(0, "@lsp.type." .. kind .. ".apn", { fg = color })
    end
end
colors()
vim.api.nvim_create_autocmd("ColorScheme", { group = group, callback = colors })
local function attach(buf)
    if vim.bo[buf].filetype ~= "apn" then return end
    vim.bo[buf].shiftwidth = 4
    vim.bo[buf].tabstop = 4
    vim.bo[buf].expandtab = true
    vim.bo[buf].commentstring = "# %s"
    local client = vim.lsp.start({
        name = "apn",
        -- Deno text imports require explicit read access to the embedded prelude.
        cmd = { "deno", "run", "--allow-read=" .. root .. "/lib/match.apn," .. root .. "/lib/type.apn," .. root .. "/lib/do.apn", root .. "/main.ts", "--lsp" },
        root_dir = vim.fs.root(vim.api.nvim_buf_get_name(buf), { ".git" }) or vim.fn.getcwd(),
        on_attach = function(_, b)
            vim.bo[b].omnifunc = "v:lua.vim.lsp.omnifunc"
            vim.keymap.set("n", "K", vim.lsp.buf.hover, { buffer = b, desc = "APN hover" })
            vim.keymap.set("n", "<leader>cd", vim.diagnostic.open_float, { buffer = b, desc = "APN diagnostic" })
        end,
    }, { bufnr = buf })
    return client
end
vim.api.nvim_create_autocmd("FileType", { group = group, pattern = "apn", callback = function(ev) attach(ev.buf) end })
-- Also support :luafile after opening an APN file.
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
        if vim.api.nvim_buf_get_name(buf):match("%.apn$") then vim.bo[buf].filetype = "apn" end
        attach(buf)
    end
end
