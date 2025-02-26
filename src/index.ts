import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';
import { LabIcon } from '@jupyterlab/ui-components';
import axe from 'axe-core';
import { ILabShell } from '@jupyterlab/application';

interface CellAccessibilityIssue {
    cellIndex: number;
    cellType: string;
    axeResults: axe.Result[];
    contentRaw: string;
}

/**
 * Extract HTML content from each cell in the notebook, run axe-core on it, and return the issues.
 */
async function analyzeCellsAccessibility(panel: NotebookPanel): Promise<CellAccessibilityIssue[]> {
    const issues: CellAccessibilityIssue[] = [];
    
    const tempDiv = document.createElement('div');
    document.body.appendChild(tempDiv);

    const axeConfig: axe.RunOptions = {
        runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        rules: {'button-name': { enabled: false }} // Disable button-name rule, should add more rules that are irrelevant.
    };

    try {
        const cells = panel.content.widgets;
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (!cell || !cell.model) {
                console.warn(`Skipping cell ${i}: Invalid cell or model`);
                continue;
            }

            let output;
            const cellType = cell.model.type;
            if (cellType === 'markdown') {
                output = cell.node.querySelector('.jp-MarkdownOutput')
            } else if (cellType === 'code') {
                output = cell.node.querySelector('.jp-OutputArea')
            }

            if (output) {
                tempDiv.innerHTML = output.innerHTML;
                if (tempDiv.innerHTML.trim()) {
                    const results = await axe.run(tempDiv, axeConfig);
                    if (results.violations.length > 0) {
                        issues.push({
                            cellIndex: i,
                            cellType: cellType,
                            axeResults: results.violations,
                            contentRaw: cell.model.sharedModel.getSource(),
                        });
                    }
                }
            } 
        }
    } finally {
        tempDiv.remove();
    }

    return issues;
}

/**
 * Format accessibility issues to feed into a language model.
 */
function formatPrompt(issue: CellAccessibilityIssue): string {
    let prompt = `The following represents a jupyter notebook cell and a accessibility issue found in it.\n\n`;

    const cellIssue = issue;
    prompt += `Content: \n${cellIssue.contentRaw}\n\n`;
    cellIssue.axeResults.forEach(issue => {
        prompt += `Issue: ${issue.id}\n\n`;
        prompt += `Description: ${issue.description}\n\n`;
    });

    return prompt;
}

/**
* Send issues to Ollama for suggestions
*/
async function getFixSuggestions(prompt: string): Promise<string[]> {
    const OLLAMA_API = "http://localhost:11434/api/generate";

    let body = JSON.stringify({ 
        model: "mistral",
        prompt: prompt,
        stream: false
    })
    
    try {
        const response = await fetch(OLLAMA_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseText = await response.text();
        const responseObj = JSON.parse(responseText);    
        try {
            // Parse the actual JSON content from the response
            const rawJSONString = responseObj.response
            .replace(/```json\n/, '')
            .replace(/\n```/, '')
            .trim();


            const result = JSON.parse(rawJSONString);
            return [result.exampleCellContent || '', result.explanation || ''];
        } catch (e) {
            console.error('Failed to parse suggestion:', e);
            return ['Invalid response format', ''];
        }
    } catch (error) {
        console.error('Error getting suggestions:', error);
        return ['Error analyzing accessibility issues', ''];
    }
}


/**
* Frontend UI for individual cell issues.
*/
class CellIssueWidget extends Widget {
    private currentNotebook: NotebookPanel | null = null;
    private cellIndex: number;
    private suggestion: string = '';

    constructor(issue: CellAccessibilityIssue, notebook: NotebookPanel) {
        super();
        this.addClass('jp-A11yPanel-issue');
        this.currentNotebook = notebook;
        this.cellIndex = issue.cellIndex;

        // Header Container UI
        const buttonContainer = document.createElement('div');
        buttonContainer.innerHTML = `
            <div class="jp-A11yPanel-buttonContainer">
                <button class="jp-Button">
                Cell error: ${issue.axeResults.map((result: any) => result.id).join(', ')}
                </button>
                <span class="jp-A11yPanel-infoIcon">&#9432;</span>
                <div class="jp-A11yPanel-popup">
                ${issue.axeResults
                    .map((result: any) => `
                    <div class="jp-A11yPanel-popupDetail">
                        <strong>${result.id}</strong><br>
                        Impact: ${result.impact}<br>
                        Description: ${result.description}<br>
                        Help: ${result.help}<br>
                        Help URL: <a href="${result.helpUrl}" target="_blank">Learn more</a>
                    </div>
                    `)
                    .join('')}
                </div>
            </div>
            `;
        const button = buttonContainer.querySelector('.jp-Button') as HTMLButtonElement;
        button.onclick = () => this.navigateToCell(issue.cellIndex);

        const infoIcon = buttonContainer.querySelector('.jp-A11yPanel-infoIcon') as HTMLElement;
        infoIcon.onclick = () => {
            const popup = buttonContainer.querySelector('.jp-A11yPanel-popup') as HTMLElement;
            popup.classList.toggle('jp-A11yPanel-popup-visible');
        };

        // AI Suggestion Container UI
        const suggestionContainer = document.createElement('div');
        suggestionContainer.innerHTML = `
          <div class="jp-A11yPanel-suggestionContainer">
            <div class="jp-A11yPanel-suggestionTop">
              <div class="jp-A11yPanel-label">AI Suggestion</div>
              <span class="jp-Icon jp-ChevronIcon"></span>
            </div>
            <div class="jp-A11yPanel-suggestion"></div>
            <div class="jp-A11yPanel-controls">
                <button class="jp-A11yPanel-applyButton">
                    Apply
                <span class="jp-Icon jp-CheckIcon"></span>
                </button>
            </div>
            <div class="jp-A11yPanel-explanationPopup"></div>
          </div>
        `;

        const applyButton = suggestionContainer.querySelector('.jp-A11yPanel-applyButton') as HTMLElement;
        applyButton.onclick = () => {
            this.applySuggestion();
        };
    
        const aiSuggestion = suggestionContainer.querySelector('.jp-A11yPanel-suggestion') as HTMLElement;
        const explanationPopup = suggestionContainer.querySelector('.jp-A11yPanel-explanationPopup') as HTMLElement;
        const explanationIcon = suggestionContainer.querySelector('.jp-Icon.jp-ChevronIcon') as HTMLElement;

        // Set up the explanation popup toggle
        explanationIcon.onclick = () => {
            explanationPopup.classList.toggle('jp-A11yPanel-explanationPopup-visible');
        };

        this.node.appendChild(buttonContainer);
        this.node.appendChild(suggestionContainer);

        console.log(formatPrompt(issue));
        // Update suggestion when we get the response
        getFixSuggestions(formatPrompt(issue)).then(([suggestion, explanation]) => {
            this.suggestion = suggestion; // Store the suggestion
            aiSuggestion.textContent = suggestion;
            explanationPopup.textContent = 'AI Explanation: ' +explanation;
        });
    }

    private navigateToCell(index: number): void {
        const notebook = document.querySelector('.jp-Notebook') as HTMLElement;
        const cells = notebook?.querySelectorAll('.jp-Cell');
        const targetCell = cells?.[index] as HTMLElement;

        if (targetCell) {
            // Scroll to the cell
            targetCell.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Highlight the cell with a brighter yellow
            targetCell.style.transition = 'background-color 0.5s ease';
            targetCell.style.backgroundColor = '#FFFFC5'; // Bright yellow

            // Remove highlight after a short delay
            setTimeout(() => {
                targetCell.style.backgroundColor = ''; // Reset to original
            }, 2000); // Highlight for 2 seconds
        }
    }

    private async applySuggestion(): Promise<void> {
        if (!this.currentNotebook || !this.suggestion) return;

        const cell = this.currentNotebook.content.widgets[this.cellIndex];
        if (cell && cell.model) {
            // Apply the suggestion
            cell.model.sharedModel.setSource(this.suggestion);
            
            // Re-analyze the specific cell
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = cell.node.innerHTML;
            
            // Not entirely working.
            try {
                const results = await axe.run(tempDiv, {
                    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
                    rules: {'button-name': { enabled: false }}
                });
                
                // If no violations found, remove this widget
                if (results.violations.length === 0) {
                    this.node.remove(); // Remove from DOM
                    this.dispose();    // Clean up widget
                }
            } finally {
                tempDiv.remove();
            }
        }
    }
}

/**
* Frontend UI for the main panel.
*/
class A11yMainPanel extends Widget {
    constructor() {
        super();
        this.addClass('jp-A11yPanel');
        this.id = 'a11y-sidebar';
        
        const header = document.createElement('h2');
        header.textContent = 'Accessibility Checker';
        header.className = 'jp-A11yPanel-header';
        
        const accessibilityIcon = new LabIcon({
            name: 'a11y:accessibility',
            svgstr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#154F92" d="M256 48c114.953 0 208 93.029 208 208 0 114.953-93.029 208-208 208-114.953 0-208-93.029-208-208 0-114.953 93.029-208 208-208m0-40C119.033 8 8 119.033 8 256s111.033 248 248 248 248-111.033 248-248S392.967 8 256 8zm0 56C149.961 64 64 149.961 64 256s85.961 192 192 192 192-85.961 192-192S362.039 64 256 64zm0 44c19.882 0 36 16.118 36 36s-16.118 36-36 36-36-16.118-36-36 16.118-36 36-36zm117.741 98.023c-28.712 6.779-55.511 12.748-82.14 15.807.851 101.023 12.306 123.052 25.037 155.621 3.617 9.26-.957 19.698-10.217 23.315-9.261 3.617-19.699-.957-23.316-10.217-8.705-22.308-17.086-40.636-22.261-78.549h-9.686c-5.167 37.851-13.534 56.208-22.262 78.549-3.615 9.255-14.05 13.836-23.315 10.217-9.26-3.617-13.834-14.056-10.217-23.315 12.713-32.541 24.185-54.541 25.037-155.621-26.629-3.058-53.428-9.027-82.141-15.807-8.6-2.031-13.926-10.648-11.895-19.249s10.647-13.926 19.249-11.895c96.686 22.829 124.283 22.783 220.775 0 8.599-2.03 17.218 3.294 19.249 11.895 2.029 8.601-3.297 17.219-11.897 19.249z"/></svg>'
        });

        this.title.icon = accessibilityIcon;
        this.title.caption = 'Accessibility';
        
        const analyzeButton = document.createElement('button');
        analyzeButton.className = 'jp-Button';
        analyzeButton.textContent = 'Analyze Notebook';
        analyzeButton.onclick = () => this.analyzeCurrentNotebook();
        
        this.issuesContainer = document.createElement('div');
        this.issuesContainer.className = 'jp-A11yPanel-issues';
        
        this.node.appendChild(header);
        this.node.appendChild(analyzeButton);
        this.node.appendChild(this.issuesContainer);
    }

    private issuesContainer: HTMLElement;
    private currentNotebook: NotebookPanel | null = null;

    setNotebook(notebook: NotebookPanel) {
        this.currentNotebook = notebook;
    }

    private async analyzeCurrentNotebook() {
        if (!this.currentNotebook) return;
        
        this.issuesContainer.innerHTML = '';
        
        const issues = await analyzeCellsAccessibility(this.currentNotebook);
        
        issues.forEach(issue => {
            const issueWidget = new CellIssueWidget(issue, this.currentNotebook!);
            this.issuesContainer.appendChild(issueWidget.node);
        });
    }
}

const extension: JupyterFrontEndPlugin<void> = {
    id: 'jupyterlab-a11y-fix',
    autoStart: true,
    requires: [ILabShell],
    activate: (app: JupyterFrontEnd, labShell: ILabShell) => {
        const panel = new A11yMainPanel();
        
        labShell.add(panel, 'right');

        // Update current notebook when active widget changes
        labShell.currentChanged.connect(() => {
            const current = labShell.currentWidget;
            if (current instanceof NotebookPanel) {
                panel.setNotebook(current);
            }
        });
    }
};

export default extension;
