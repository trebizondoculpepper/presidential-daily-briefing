# API-first serve boundary

Recorded the owner's architecture principle in contributor guidance and a separate contract: backend services/APIs own domain content; frontend components consume it and render. Rules is the first focused migration, reusing its existing backend RulesDocument/narration rather than duplicating rules logic in the browser.

Created estimated architecture #852 and implementation #853, with the latter blocked on the reviewed contract. Existing generated HTML is migration debt; no whole-app rewrite, automatic framework promotion, CLI/MCP HTTP requirement or new security infrastructure is implied. No runtime changed.
