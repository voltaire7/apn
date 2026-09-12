-- Session-only APN support. Source this file; nothing is installed in your config.
local script = debug.getinfo(1, "S").source:sub(2)
local root = vim.fn.fnamemodify(script, ":p:h:h:h")
vim.filetype.add({ extension = { apn = "apn" } })
local group = vim.api.nvim_create_augroup("ApnLocal", { clear = true })
local function attach(buf)
    if vim.bo[buf].filetype ~= "apn" then return end
    vim.bo[buf].shiftwidth = 4
    vim.bo[buf].tabstop = 4
    vim.bo[buf].expandtab = true
    vim.bo[buf].commentstring = "# %s"
    local client = vim.lsp.start({
        name = "apn",
        -- Deno text imports require explicit read access to the embedded prelude.
        cmd = { "deno", "run", "--allow-read=" .. root .. "/lib/match.apn", root .. "/main.ts", "--lsp" },
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
