import React from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDotDashed,
  CircleX,
} from "lucide-react";
import { motion, AnimatePresence, LayoutGroup, type Variants } from "framer-motion";

// ─── Types ──────────────────────────────────────────────────────────────────
// Kept compatible with the original reference component's shape, but this is
// now a CONTROLLED component: tasks/expansion state are owned by the caller.
// The original shipped with hardcoded demo data and a status button that
// assigned a RANDOM status on click -- neither survived integration, since
// this renders the real agent loop's real tool calls (see
// components/chat/_utils_/agentPlanMapper.ts for how Task[] gets built from
// live onStepFinish events).

export interface Subtask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  /** Real tool names used for this step (e.g. "write_file", "query_database") -- not MCP server names. */
  tools?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  level: number;
  dependencies: string[];
  subtasks: Subtask[];
}

interface PlanProps {
  tasks: Task[];
  expandedTasks: string[];
  onToggleTask: (taskId: string) => void;
  expandedSubtasks: Record<string, boolean>;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
}

export default function Plan({
  tasks,
  expandedTasks,
  onToggleTask,
  expandedSubtasks,
  onToggleSubtask,
}: PlanProps) {
  const prefersReducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  const taskVariants: Variants = {
    hidden: {
      opacity: 0,
      y: prefersReducedMotion ? 0 : -5,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        type: prefersReducedMotion ? "tween" : "spring",
        stiffness: 500,
        damping: 30,
        duration: prefersReducedMotion ? 0.2 : undefined,
      },
    },
    exit: {
      opacity: 0,
      y: prefersReducedMotion ? 0 : -5,
      transition: { duration: 0.15 },
    },
  };

  const subtaskListVariants: Variants = {
    hidden: {
      opacity: 0,
      height: 0,
      overflow: "hidden",
    },
    visible: {
      height: "auto",
      opacity: 1,
      overflow: "visible",
      transition: {
        duration: 0.25,
        staggerChildren: prefersReducedMotion ? 0 : 0.05,
        when: "beforeChildren",
        ease: [0.2, 0.65, 0.3, 0.9],
      },
    },
    exit: {
      height: 0,
      opacity: 0,
      overflow: "hidden",
      transition: {
        duration: 0.2,
        ease: [0.2, 0.65, 0.3, 0.9],
      },
    },
  };

  const subtaskVariants: Variants = {
    hidden: {
      opacity: 0,
      x: prefersReducedMotion ? 0 : -10,
    },
    visible: {
      opacity: 1,
      x: 0,
      transition: {
        type: prefersReducedMotion ? "tween" : "spring",
        stiffness: 500,
        damping: 25,
        duration: prefersReducedMotion ? 0.2 : undefined,
      },
    },
    exit: {
      opacity: 0,
      x: prefersReducedMotion ? 0 : -10,
      transition: { duration: 0.15 },
    },
  };

  const subtaskDetailsVariants: Variants = {
    hidden: {
      opacity: 0,
      height: 0,
      overflow: "hidden",
    },
    visible: {
      opacity: 1,
      height: "auto",
      overflow: "visible",
      transition: {
        duration: 0.25,
        ease: [0.2, 0.65, 0.3, 0.9],
      },
    },
  };

  const statusBadgeVariants: Variants = {
    initial: { scale: 1 },
    animate: {
      scale: prefersReducedMotion ? 1 : [1, 1.08, 1],
      transition: {
        duration: 0.35,
        ease: [0.34, 1.56, 0.64, 1],
      },
    },
  };

  return (
    <div className="w-full text-white/70">
      <motion.div
        className="rounded-xl bg-white/[0.02] overflow-hidden"
        initial={{ opacity: 0, y: 10 }}
        animate={{
          opacity: 1,
          y: 0,
          transition: {
            duration: 0.3,
            ease: [0.2, 0.65, 0.3, 0.9],
          },
        }}
      >
        <LayoutGroup>
          <div className="p-2 overflow-hidden">
            <ul className="space-y-0.5 overflow-hidden">
              {tasks.map((task, index) => {
                const isExpanded = expandedTasks.includes(task.id);
                const isCompleted = task.status === "completed";

                return (
                  <motion.li
                    key={task.id}
                    className={` ${index !== 0 ? "mt-0.5 pt-1" : ""} `}
                    initial="hidden"
                    animate="visible"
                    variants={taskVariants}
                  >
                    {/* Task row */}
                    <motion.div
                      className="group flex items-center px-2 py-1 rounded-md"
                      whileHover={{
                        backgroundColor: "rgba(255,255,255,0.04)",
                        transition: { duration: 0.2 },
                      }}
                    >
                      <motion.div
                        className="mr-2 flex-shrink-0"
                        whileHover={{ scale: 1.1 }}
                      >
                        <AnimatePresence mode="wait">
                          <motion.div
                            key={task.status}
                            initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
                            animate={{ opacity: 1, scale: 1, rotate: 0 }}
                            exit={{ opacity: 0, scale: 0.8, rotate: 10 }}
                            transition={{
                              duration: 0.2,
                              ease: [0.2, 0.65, 0.3, 0.9],
                            }}
                          >
                            {task.status === "completed" ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                            ) : task.status === "in-progress" ? (
                              <CircleDotDashed className="h-4 w-4 text-indigo-400 animate-spin" style={{ animationDuration: '2s' }} />
                            ) : task.status === "need-help" ? (
                              <CircleAlert className="h-4 w-4 text-amber-400" />
                            ) : task.status === "failed" ? (
                              <CircleX className="h-4 w-4 text-red-400" />
                            ) : (
                              <Circle className="text-white/25 h-4 w-4" />
                            )}
                          </motion.div>
                        </AnimatePresence>
                      </motion.div>

                      <motion.div
                        className="flex min-w-0 flex-grow cursor-pointer items-center justify-between"
                        onClick={() => onToggleTask(task.id)}
                      >
                        <div className="mr-2 flex-1 truncate">
                          <span
                            className={`text-[12.5px] ${isCompleted ? "text-white/40" : "text-white/80"}`}
                          >
                            {task.title}
                          </span>
                        </div>

                        <div className="flex flex-shrink-0 items-center space-x-2 text-xs">
                          <motion.span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              task.status === "completed"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : task.status === "in-progress"
                                  ? "bg-indigo-500/15 text-indigo-300"
                                  : task.status === "need-help"
                                    ? "bg-amber-500/15 text-amber-300"
                                    : task.status === "failed"
                                      ? "bg-red-500/15 text-red-300"
                                      : "bg-white/[0.06] text-white/40"
                            }`}
                            variants={statusBadgeVariants}
                            initial="initial"
                            animate="animate"
                            key={task.status}
                          >
                            {task.status}
                          </motion.span>
                        </div>
                      </motion.div>
                    </motion.div>

                    {/* Subtasks - staggered */}
                    <AnimatePresence mode="wait">
                      {isExpanded && task.subtasks.length > 0 && (
                        <motion.div
                          className="relative overflow-hidden"
                          variants={subtaskListVariants}
                          initial="hidden"
                          animate="visible"
                          exit="hidden"
                          layout
                        >
                          <ul className="mt-1 mr-2 mb-1.5 ml-3 space-y-0.5">
                            {task.subtasks.map((subtask) => {
                              const subtaskKey = `${task.id}-${subtask.id}`;
                              const isSubtaskExpanded = expandedSubtasks[subtaskKey];

                              return (
                                <motion.li
                                  key={subtask.id}
                                  className="group flex flex-col py-0.5 pl-6"
                                  onClick={() =>
                                    onToggleSubtask(task.id, subtask.id)
                                  }
                                  variants={subtaskVariants}
                                  initial="hidden"
                                  animate="visible"
                                  exit="exit"
                                  layout
                                >
                                  <motion.div
                                    className="flex flex-1 items-center rounded-md p-1"
                                    whileHover={{
                                      backgroundColor: "rgba(255,255,255,0.04)",
                                      transition: { duration: 0.2 },
                                    }}
                                    layout
                                  >
                                    <motion.div className="mr-2 flex-shrink-0" layout>
                                      <AnimatePresence mode="wait">
                                        <motion.div
                                          key={subtask.status}
                                          initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
                                          animate={{ opacity: 1, scale: 1, rotate: 0 }}
                                          exit={{ opacity: 0, scale: 0.8, rotate: 10 }}
                                          transition={{
                                            duration: 0.2,
                                            ease: [0.2, 0.65, 0.3, 0.9],
                                          }}
                                        >
                                          {subtask.status === "completed" ? (
                                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                          ) : subtask.status === "in-progress" ? (
                                            <CircleDotDashed className="h-3.5 w-3.5 text-indigo-400 animate-spin" style={{ animationDuration: '2s' }} />
                                          ) : subtask.status === "need-help" ? (
                                            <CircleAlert className="h-3.5 w-3.5 text-amber-400" />
                                          ) : subtask.status === "failed" ? (
                                            <CircleX className="h-3.5 w-3.5 text-red-400" />
                                          ) : (
                                            <Circle className="text-white/25 h-3.5 w-3.5" />
                                          )}
                                        </motion.div>
                                      </AnimatePresence>
                                    </motion.div>

                                    <span className="cursor-pointer text-[12px] text-white/65">
                                      {subtask.title}
                                    </span>
                                  </motion.div>

                                  <AnimatePresence mode="wait">
                                    {isSubtaskExpanded && (
                                      <motion.div
                                        className="text-white/40 mt-1 ml-1.5 pl-5 text-xs overflow-hidden"
                                        variants={subtaskDetailsVariants}
                                        initial="hidden"
                                        animate="visible"
                                        exit="hidden"
                                        layout
                                      >
                                        {subtask.description && (
                                          <p className="py-1">{subtask.description}</p>
                                        )}
                                        {subtask.tools && subtask.tools.length > 0 && (
                                          <div className="mt-0.5 mb-1 flex flex-wrap items-center gap-1.5">
                                            <div className="flex flex-wrap gap-1">
                                              {subtask.tools.map((tool, idx) => (
                                                <motion.span
                                                  key={idx}
                                                  className="bg-indigo-500/10 text-indigo-300/80 rounded px-1.5 py-0.5 text-[10px] font-medium font-mono"
                                                  initial={{ opacity: 0, y: -5 }}
                                                  animate={{
                                                    opacity: 1,
                                                    y: 0,
                                                    transition: {
                                                      duration: 0.2,
                                                      delay: idx * 0.05,
                                                    },
                                                  }}
                                                >
                                                  {tool}
                                                </motion.span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </motion.li>
                              );
                            })}
                          </ul>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.li>
                );
              })}
            </ul>
          </div>
        </LayoutGroup>
      </motion.div>
    </div>
  );
}
