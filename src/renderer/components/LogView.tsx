import { useState } from 'react';
import { Database, History, Layers, ScrollText, Trophy } from 'lucide-react';
import { Page, TabPanel, Tabs, type TabItem } from '@renderer/components/ui';
import { formatCount } from '@renderer/lib/format';
import { useHunts, useSessions } from '@renderer/store';
import { DataTab } from './hunt/DataTab';
import { PhasesTab, SessionsTab, TrophiesTab } from './hunt/LogTabs';
import styles from './hunt/log.module.css';

type LogTab = 'phases' | 'sessions' | 'trophies' | 'data';

const TABS_ID = 'log';

/** Log view — phase logs, session history, finished hunts, and export / import. */
export default function LogView() {
  const hunts = useHunts();
  const sessions = useSessions();
  const [tab, setTab] = useState<LogTab>('phases');

  const phaseCount = hunts.reduce((sum, hunt) => sum + hunt.phases.length, 0);
  const trophyCount = hunts.filter((hunt) => hunt.status === 'completed').length;
  const badge = (count: number): string | undefined => (count > 0 ? formatCount(count) : undefined);

  const items: TabItem<LogTab>[] = [
    { id: 'phases', label: 'Phases', icon: <Layers />, badge: badge(phaseCount) },
    { id: 'sessions', label: 'Sessions', icon: <History />, badge: badge(sessions.length) },
    { id: 'trophies', label: 'Trophies', icon: <Trophy />, badge: badge(trophyCount) },
    { id: 'data', label: 'Data', icon: <Database /> },
  ];

  return (
    <Page
      title="Log"
      subtitle="Phases, sessions, trophies — and your data, in and out"
      icon={<ScrollText />}
      toolbar={
        <Tabs id={TABS_ID} items={items} value={tab} onChange={setTab} aria-label="Log sections" />
      }
    >
      <div className={styles.view}>
        <TabPanel tabsId={TABS_ID} tabId="phases" active={tab === 'phases'}>
          <PhasesTab />
        </TabPanel>
        <TabPanel tabsId={TABS_ID} tabId="sessions" active={tab === 'sessions'}>
          <SessionsTab />
        </TabPanel>
        <TabPanel tabsId={TABS_ID} tabId="trophies" active={tab === 'trophies'}>
          <TrophiesTab />
        </TabPanel>
        <TabPanel tabsId={TABS_ID} tabId="data" active={tab === 'data'}>
          <DataTab />
        </TabPanel>
      </div>
    </Page>
  );
}
