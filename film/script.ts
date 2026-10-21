// What the film's omp is asked and answers. REPLY is written as /stretch dense asks: each
// paragraph's gist in view, the rest behind stretches, one nested.
export const QUESTION = "Why does git rebase rewrite my commits?";

export const REPLY = `{{Rebase replays your commits on a new base.|Rebase takes each commit on your branch and replays it, one by one, on top of a new base, usually the tip of \`main\`.}}

{{Each replayed commit gets a new hash.|Each replayed commit gets a new hash, because {{a hash covers its parent|a commit's hash covers its parent's hash as well as its own tree, author and message}}, and every parent changed.}}

- {{Safe on a branch only you use.|Safe on a branch only you use, since nobody else holds the old hashes.}}
- {{Shared branches need a force push.|Shared branches need a force push afterwards, and everyone who pulled must reset to the new history.}}`;

export const LIGHT_QUESTION = "How do I undo a rebase that went wrong?";

export const LIGHT_REPLY = `Right after the rebase, \`git reset --hard ORIG_HEAD\` puts your branch back where it was. {{Git saved that spot for you.|Git saved the old tip in \`ORIG_HEAD\` before the rebase started, and the old commits stay in the repository even though no branch points at them.}}

If you ran other commands since, find the old tip in \`git reflog\` and reset to that entry instead. {{Stash uncommitted work first.|Stash uncommitted work first, because \`reset --hard\` throws it away.}}`;
