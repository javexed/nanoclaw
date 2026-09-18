// ── Styled confirm — replaces native confirm() so destructive prompts match
// the app's dialogs (finding 9 of the UX review). Resolves false on Escape,
// backdrop close, or Cancel; true only on the explicit action button.
export function confirmDialog(message, confirmLabel = 'Delete') {
    return new Promise((resolve) => {
        let decided = false;
        const dlg = document.createElement('dialog');
        dlg.className = 'confirm-dialog';
        const p = document.createElement('p');
        p.textContent = message;
        const row = document.createElement('menu');
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => dlg.close();
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'mdanger';
        ok.textContent = confirmLabel;
        ok.onclick = () => {
            decided = true;
            dlg.close();
        };
        dlg.addEventListener('close', () => {
            dlg.remove();
            resolve(decided);
        });
        row.append(cancel, ok);
        dlg.append(p, row);
        document.body.appendChild(dlg);
        dlg.showModal();
    });
}
