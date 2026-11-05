"use client";

import { useRef, useState } from "react";
import { ConfirmButton } from "./ConfirmButton";
import { Icon } from "./Icon";

type Action = (fd: FormData) => void | Promise<void>;

/** Inbox reply box: removable Cc chips, the draft, Draft with AI, and Send (also Cmd/Ctrl+Enter). */
export function Composer({ replyId, sender, draft, cc, send, draftWithAi, discard }: { replyId: string; sender: string; draft: string; cc: string[]; send: Action; draftWithAi: Action; discard: Action }) {
  const [chips, setChips] = useState(cc);
  const [typing, setTyping] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const add = () => {
    const v = typing.trim().replace(/,$/, "");
    if (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !chips.includes(v)) setChips([...chips, v]);
    setTyping("");
  };

  return (
    <form ref={form} action={send} className="composer-box">
      <input type="hidden" name="id" value={replyId} />
      <input type="hidden" name="cc" value={chips.join(",")} />
      <div className="from-row">
        <Icon name="reply" size={14} />
        <span>
          Reply as <b>{sender}</b>
        </span>
        {draft && (
          <span className="ai-tag">
            <Icon name="sparkle" size={12} /> AI draft, edit freely
          </span>
        )}
      </div>
      <div className="cc-row">
        <span className="small muted">Cc</span>
        {chips.map((c) => (
          <span key={c} className="cc-chip">
            {c}
            <button type="button" aria-label={`Remove ${c}`} onClick={() => setChips(chips.filter((x) => x !== c))}>
              <Icon name="x" size={13} />
            </button>
          </span>
        ))}
        <input
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
              if (typing.trim()) e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder="Add email…"
          aria-label="Add Cc"
        />
      </div>
      <textarea
        name="body"
        defaultValue={draft}
        placeholder="Write your reply…"
        aria-label="Reply"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (window.confirm("Send this reply now?")) form.current?.requestSubmit();
          }
        }}
      />
      <div className="bar">
        <ConfirmButton formAction={draftWithAi} className="sm ghostbtn">
          <Icon name="sparkle" size={14} /> {draft ? "Redraft with AI" : "Draft with AI"}
        </ConfirmButton>
        {draft && (
          <ConfirmButton formAction={discard} className="sm ghostbtn">
            Discard draft
          </ConfirmButton>
        )}
        <span style={{ flex: 1 }} />
        <span className="small muted hint">Signature and footer are added automatically</span>
        <ConfirmButton className="primary sm" confirm="Send this reply now?">
          Send <kbd>⌘</kbd>
          <kbd>↵</kbd>
        </ConfirmButton>
      </div>
    </form>
  );
}
