import type { BlockResult } from '../api';

interface Props {
  blocks: BlockResult[];
}

const hex = (n: number, width = 4) => `0x${n.toString(16).padStart(width, '0')}`;

/**
 * Raw dump of every polled block. This is the view that identifies unknown
 * registers: watch it while the inverter changes state and note what moves.
 */
export default function RawExplorer({ blocks }: Props) {
  if (blocks.length === 0) {
    return (
      <section>
        <h2>Raw registers</h2>
        <p className="desc">Connect to read.</p>
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>Raw registers</h2>
        <p className="desc">
          Every register in the polled blocks, exactly as read. The address space is
          sparse — only 13 blocks of 256 exist, and a missing block returns Modbus
          exception 2 rather than data. Watch this page while the inverter starts charging
          to find the PV and load registers.
        </p>
      </section>

      {blocks.map((block) => (
        <section key={block.addr}>
          <h2 className="mono">{hex(block.addr)}</h2>
          {block.error ? (
            <p className="desc err">{block.error}</p>
          ) : (
            <table className="raw">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Offset</th>
                  <th>Decimal</th>
                  <th>Hex</th>
                  <th>÷10</th>
                  <th>×0.4</th>
                  <th>ASCII</th>
                </tr>
              </thead>
              <tbody>
                {(block.values ?? []).map((value, i) => (
                  <tr key={i}>
                    <td className="mono">{hex(block.addr + i)}</td>
                    <td>+{i}</td>
                    <td>{value}</td>
                    <td className="mono">{hex(value)}</td>
                    <td>{(value / 10).toFixed(1)}</td>
                    <td>{(value * 0.4).toFixed(1)}</td>
                    <td className="mono">
                      {value >= 32 && value < 127 ? String.fromCharCode(value) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </>
  );
}
