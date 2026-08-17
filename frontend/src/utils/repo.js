// Where Bindarr lives, and how the app hands the user a prefilled issue.
//
// Prefilled, never submitted: these build a URL that opens GitHub's new-issue
// form with the boilerplate already typed in. The user still reads it and presses
// Submit themselves, which is the point — nothing leaves the browser until they
// decide it should.

export const REPO_URL = 'https://github.com/thenotoriousJeremy/bindarr';

export const issueUrl = ({ labels = '', title = '', body = '' }) =>
  `${REPO_URL}/issues/new?labels=${encodeURIComponent(labels)}`
  + `&title=${encodeURIComponent(title)}`
  + `&body=${encodeURIComponent(body)}`;
